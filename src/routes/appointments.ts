import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { MAX_SERVICES, parseLocalDate, parseTimeToMinutes, validateSlot } from "../lib/schedule.js";

export const appointmentsRouter = Router();

// Letras (com acento), espaço, hífen e apóstrofo — mesma regra do front
const NAME_PATTERN = /^\p{L}[\p{L}' -]*$/u;
// Celular brasileiro no formato internacional: +55 + DDD + 9 + 8 dígitos
const PHONE_PATTERN = /^\+55[1-9]{2}9\d{8}$/;

// Evita robôs enchendo a agenda: 10 pedidos por aparelho a cada hora
const bookingLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipFailedRequests: true, // só agendamentos criados contam
    message: { error: "Muitos agendamentos deste aparelho. Tente novamente mais tarde." },
});

function cleanName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const name = value.trim().replace(/\s+/g, " "); // tira espaços duplicados
    if (name.length < 2 || name.length > 50 || !NAME_PATTERN.test(name)) return null;
    return name;
}

function parseServiceIds(value: unknown): number[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SERVICES) return null;
    if (!value.every((id) => Number.isInteger(id) && id > 0)) return null;
    if (new Set(value).size !== value.length) return null; // sem repetidos
    return value as number[];
}

// O banco recusou por sobreposição? (código 23P01 do PostgreSQL)
function isOverlapError(error: unknown): boolean {
    let text = error instanceof Error ? error.message : String(error);
    try {
        text += JSON.stringify(error);
    } catch {
        // alguns erros não viram JSON; a mensagem já basta
    }
    return text.includes("appointments_no_overlap") || text.includes("23P01");
}

appointmentsRouter.post("/", bookingLimiter, async (req, res) => {
    const { serviceIds, date, time, customer } = req.body ?? {};

    // 1. Formato dos dados (nada do navegador é confiável)
    const ids = parseServiceIds(serviceIds);
    const localDate = parseLocalDate(date);
    const startMinute = parseTimeToMinutes(time);
    const firstName = cleanName(customer?.firstName);
    const lastName = cleanName(customer?.lastName);
    const phone = customer?.phone;
    const whatsappOptIn = customer?.whatsappOptIn === true;

    if (!ids || !localDate || startMinute === null || !firstName || !lastName ||
        typeof phone !== "string" || !PHONE_PATTERN.test(phone)) {
        res.status(400).json({ error: "Dados do agendamento inválidos." });
        return;
    }

    // 2. Serviços vêm do BANCO: preço e duração nunca vêm do navegador
    const found = await prisma.service.findMany({ where: { id: { in: ids }, active: true } });
    if (found.length !== ids.length) {
        res.status(400).json({ error: "Algum serviço escolhido não está disponível." });
        return;
    }
    // Mantém a ordem em que a cliente escolheu
    const services = ids.map((id) => found.find((s) => s.id === id)!);

    const totalMinutes = services.reduce((sum, s) => sum + s.durationMinutes, 0);
    // Soma em centavos (inteiros) para não ter erro de arredondamento
    const totalCents = services.reduce((sum, s) => sum + Math.round(Number(s.price) * 100), 0);

    // 3. Regras de horário (expediente, folgas, antecedência...)
    const slot = await validateSlot(localDate, startMinute, totalMinutes);
    if (!slot.ok) {
        res.status(400).json({ error: slot.error });
        return;
    }

    // 4. Salva tudo junto: se qualquer parte falhar, nada fica salvo
    try {
        const appointment = await prisma.$transaction(async (tx) => {
        // Mesma pessoa (mesmo celular) reaproveita o cadastro.
        // O nome existente NÃO é trocado: assim ninguém altera o cadastro
        // de outra pessoa só por saber o número dela.
        const client = await tx.client.upsert({
            where: { phone },
            create: {
            name: `${firstName} ${lastName}`,
            phone,
            whatsappOptInAt: whatsappOptIn ? new Date() : null,
            },
            update: whatsappOptIn ? { whatsappOptInAt: new Date() } : {},
        });

        return tx.appointment.create({
            data: {
            clientId: client.id,
            customerName: `${firstName} ${lastName}`,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            totalPrice: (totalCents / 100).toFixed(2), // texto: o Decimal não perde centavos
            // "Fotografia" do serviço: se o preço mudar amanhã, este agendamento não muda
            items: {
                create: services.map((s) => ({
                serviceId: s.id,
                serviceName: s.name,
                price: s.price,
                durationMinutes: s.durationMinutes,
                })),
            },
            },
            select: { id: true, startsAt: true, endsAt: true, totalPrice: true, status: true },
        });
        });

        res.status(201).json({ ...appointment, services: services.map((s) => s.name) });
    } catch (error) {
        if (isOverlapError(error)) {
        // 409 = conflito: alguém pegou esse horário primeiro
        res.status(409).json({ error: "Esse horário acabou de ser reservado. Escolha outro." });
        return;
        }
        throw error; // erro inesperado: o Express responde 500
    }
});