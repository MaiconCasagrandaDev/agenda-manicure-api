import "dotenv/config"; // precisa vir antes do prisma.ts, que lê o DATABASE_URL
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";

// 09:00 -> 540 (minutos desde a meia-noite)
const toMinutes = (hours: number, minutes = 0) => hours * 60 + minutes;

// Preço em texto para não perder centavos no Decimal
const SERVICES = [
    { name: "Mão", price: "35.00", durationMinutes: 40 },
    { name: "Pé", price: "40.00", durationMinutes: 50 },
    { name: "Pé e mão", price: "70.00", durationMinutes: 90 },
];

// Domingo (0) fica sem linha = fechado
const WORKING_HOURS = [
    ...[1, 2, 3, 4, 5].flatMap((weekday) => [
        { weekday, startMinute: toMinutes(9), endMinute: toMinutes(12) },
        { weekday, startMinute: toMinutes(13), endMinute: toMinutes(18) },
    ]),
    { weekday: 6, startMinute: toMinutes(9), endMinute: toMinutes(12) },
    { weekday: 6, startMinute: toMinutes(13), endMinute: toMinutes(16) },
];

// Regra de senha (OWASP/NIST, sem verificação em duas etapas): mínimo 15, máximo 128
const PASSWORD_MIN = 15;
const PASSWORD_MAX = 128;

function readAdminCredentials() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;

    if (!email || !password) {
        throw new Error("Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env");
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        throw new Error(`ADMIN_PASSWORD precisa ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres`);
    }

    return { email, password };
}

async function main() {
    const admin = readAdminCredentials();
    const passwordHash = await hashPassword(admin.password);

    // Tudo ou nada. Regra: só preenche o que está vazio, nunca sobrescreve
    const result = await prisma.$transaction(async (tx) => {
        const servicesExist = (await tx.service.count()) > 0;
        const servicesCreated = servicesExist
        ? 0
        : (await tx.service.createMany({ data: SERVICES })).count;

        const hoursExist = (await tx.workingHours.count()) > 0;
        const hoursCreated = hoursExist
        ? 0
        : (await tx.workingHours.createMany({ data: WORKING_HOURS })).count;

        // Se o login já existe, a senha atual é mantida
        const existingAdmin = await tx.adminUser.findUnique({
        where: { email: admin.email },
        });
        if (!existingAdmin) {
        await tx.adminUser.create({ data: { email: admin.email, passwordHash } });
        }

        return { servicesCreated, hoursCreated, adminCreated: !existingAdmin };
    });

    console.log(
        result.servicesCreated > 0
        ? `Serviços: ${result.servicesCreated} criados`
        : "Serviços: já existiam, nada alterado",
    );
    console.log(
        result.hoursCreated > 0
        ? `Expediente: ${result.hoursCreated} faixas de horário criadas`
        : "Expediente: já existia, nada alterado",
    );
    console.log(
        result.adminCreated
        ? `Login: ${admin.email} criado`
        : `Login: ${admin.email} já existia, senha mantida`,
    );
}

main()
    .catch((error: unknown) => {
        console.error(
        "Seed falhou:",
        error instanceof Error ? error.message : error,
        );
        process.exitCode = 1; // sinaliza erro sem interromper o $disconnect
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
