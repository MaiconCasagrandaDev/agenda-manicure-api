import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import {
  DAY_MS,
  MAX_DAYS_AHEAD,
  MAX_SERVICES,
  listAvailableDays,
} from "../lib/schedule.js";

export const availabilityRouter = Router();

// Consulta é leve, mas pública: 60 por minuto por aparelho é mais que suficiente
const availabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Muitas consultas. Aguarde um instante." },
});

// "1,3" → [1, 3]
function parseServiceIdsParam(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  const ids = value.split(",").map(Number);
  if (ids.length === 0 || ids.length > MAX_SERVICES) return null;
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) return null;
  if (new Set(ids).size !== ids.length) return null; // sem repetidos
  return ids;
}

availabilityRouter.get("/", availabilityLimiter, async (req, res) => {
  const ids = parseServiceIdsParam(req.query.serviceIds);
  if (!ids) {
    res.status(400).json({ error: "Serviços inválidos." });
    return;
  }

  // Duração vem do banco (igual ao agendamento)
  const services = await prisma.service.findMany({
    where: { id: { in: ids }, active: true },
    select: { durationMinutes: true },
  });
  if (services.length !== ids.length) {
    res.status(400).json({ error: "Algum serviço escolhido não está disponível." });
    return;
  }
  const durationMinutes = services.reduce((sum, s) => sum + s.durationMinutes, 0);

  const now = Date.now();
  const rangeStart = new Date(now);
  const rangeEnd = new Date(now + (MAX_DAYS_AHEAD + 1) * DAY_MS);

  // As 3 consultas rodam ao mesmo tempo
  const [blocks, timeOff, appointments] = await Promise.all([
    prisma.workingHours.findMany({
      select: { weekday: true, startMinute: true, endMinute: true },
    }),
    prisma.timeOff.findMany({
      where: { startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.appointment.findMany({
      where: {
        status: { not: "CANCELED" }, // cancelado libera o horário
        startsAt: { lt: rangeEnd },
        endsAt: { gt: rangeStart },
      },
      select: { startsAt: true, endsAt: true }, // só o horário, nada da cliente
    }),
  ]);

  res.set("Cache-Control", "no-store"); // horários mudam a todo momento
  res.json({
    durationMinutes,
    days: listAvailableDays({
      durationMinutes,
      blocks,
      busy: [...timeOff, ...appointments],
      now,
    }),
  });
});