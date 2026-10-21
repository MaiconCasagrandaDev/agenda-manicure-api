import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../lib/session.js";
import {
  addDays,
  formatLocalDate,
  localToUtc,
  parseLocalDate,
  todayInBrazil,
} from "../lib/schedule.js";

export const adminAppointmentsRouter = Router();

// TODAS as rotas deste arquivo exigem o login da manicure
adminAppointmentsRouter.use(requireAdmin);

// Dados pessoais: o navegador não guarda em cache
adminAppointmentsRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// O que o painel precisa saber de cada agendamento
const APPOINTMENT_SELECT = {
  id: true,
  customerName: true, // nome digitado no pedido
  startsAt: true,
  endsAt: true,
  totalPrice: true,
  status: true,
  confirmedAt: true,
  reminderSentAt: true,
  client: { select: { name: true, phone: true, whatsappOptInAt: true } },
  items: { select: { serviceName: true }, orderBy: { id: "asc" as const } },
};

// Ações permitidas: de qual status para qual status
const ACTIONS = {
  confirm: { from: "PENDING", to: "CONFIRMED" }, // aceitar o pedido
  decline: { from: "PENDING", to: "CANCELED" },  // recusar o pedido
  cancel: { from: "CONFIRMED", to: "CANCELED" }, // cancelar um confirmado
} as const;

type Action = keyof typeof ACTIONS;

function isAction(value: unknown): value is Action {
  return typeof value === "string" && value in ACTIONS;
}

function parseId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /admin/appointments?view=pending   → todos os pedidos pendentes futuros
// GET /admin/appointments?date=2026-10-21 → confirmados do dia (sem date = hoje)
adminAppointmentsRouter.get("/", async (req, res) => {
  const pendingCount = await prisma.appointment.count({
    where: { status: "PENDING", startsAt: { gte: new Date() } },
  });

  if (req.query.view === "pending") {
    const appointments = await prisma.appointment.findMany({
      where: { status: "PENDING", startsAt: { gte: new Date() } },
      orderBy: { startsAt: "asc" },
      select: APPOINTMENT_SELECT,
    });
    res.json({ pendingCount, appointments });
    return;
  }

  const date =
    req.query.date === undefined ? todayInBrazil() : parseLocalDate(req.query.date);
  if (!date) {
    res.status(400).json({ error: "Data inválida." });
    return;
  }

  // O "dia" em Brasília: da meia-noite até a meia-noite seguinte
  const dayStart = localToUtc(date, 0);
  const dayEnd = localToUtc(addDays(date, 1), 0);

  const appointments = await prisma.appointment.findMany({
    where: {
      status: { in: ["CONFIRMED", "DONE"] },
      startsAt: { gte: dayStart, lt: dayEnd },
    },
    orderBy: { startsAt: "asc" },
    select: APPOINTMENT_SELECT,
  });

  res.json({ date: formatLocalDate(date), pendingCount, appointments });
});

// PATCH /admin/appointments/5   body: { "action": "cancel", "blockSlot": true }
adminAppointmentsRouter.patch("/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const action = req.body?.action;
  if (!id || !isAction(action)) {
    res.status(400).json({ error: "Ação inválida." });
    return;
  }

  const { from, to } = ACTIONS[action];
  // Ao cancelar OU recusar, a Carol pode bloquear o horário
  const blockSlot = (action === "cancel" || action === "decline") && req.body?.blockSlot === true;
  const now = new Date();

  // Transação: mudar o status e (se pedido) bloquear o horário, tudo ou nada
  const appointment = await prisma.$transaction(async (tx) => {
    // Só muda se AINDA estiver no status esperado
    const result = await tx.appointment.updateMany({
      where: { id, status: from },
      data: {
        status: to,
        ...(to === "CONFIRMED" && { confirmedAt: now }),
        ...(to === "CANCELED" && { canceledAt: now }),
      },
    });
    if (result.count === 0) return null;

    const updated = await tx.appointment.findUnique({
      where: { id },
      select: APPOINTMENT_SELECT,
    });

    if (blockSlot && updated) {
      // Mesmo horário vira um bloqueio: não volta a aparecer para as clientes
      await tx.timeOff.create({
        data: {
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          reason: `Cancelado pela profissional (${updated.customerName})`,
        },
      });
    }

    return updated;
  });

  if (!appointment) {
    res.status(409).json({ error: "Esse agendamento já foi alterado. Atualize a página." });
    return;
  }
  res.json(appointment);
});

// POST /admin/appointments/5/reminder → anota que o lembrete foi enviado
adminAppointmentsRouter.post("/:id/reminder", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Agendamento inválido." });
    return;
  }

  const result = await prisma.appointment.updateMany({
    where: { id, status: "CONFIRMED" },
    data: { reminderSentAt: new Date() },
  });

  if (result.count === 0) {
    res.status(409).json({ error: "Só é possível lembrar agendamentos confirmados." });
    return;
  }
  res.status(204).end();
});