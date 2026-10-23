import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../lib/session.js";
import {
  DAY_MS,
  addDays,
  localToUtc,
  parseLocalDate,
  parseTimeToMinutes,
  weekdayOf,
  type LocalDate,
} from "../lib/schedule.js";

export const adminTimeOffRouter = Router();

// Só a manicure logada mexe nos bloqueios
adminTimeOffRouter.use(requireAdmin);
adminTimeOffRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const MAX_REASON_LENGTH = 100;
const MAX_PERIOD_DAYS = 90; // férias de até 90 dias por bloqueio
const MAX_SELECTED_DAYS = 31; // dias marcados de uma vez no calendário
const NOON = 12 * 60; // o que começa antes do meio-dia é "manhã"

// O que o painel precisa saber de cada cliente marcada (aviso e WhatsApp)
const CONFLICT_SELECT = {
  id: true,
  customerName: true,
  startsAt: true,
  endsAt: true,
  status: true,
  client: { select: { phone: true } },
  items: { select: { serviceName: true }, orderBy: { id: "asc" } },
} as const;

type Interval = { startsAt: Date; endsAt: Date };
type Parsed = { intervals: Interval[] } | { error: string };

// Dia inteiro: da meia-noite até a meia-noite seguinte (em Brasília)
function wholeDay(date: LocalDate): Interval {
  return {
    startsAt: localToUtc(date, 0),
    endsAt: localToUtc(addDays(date, 1), 0),
  };
}

// Manhã ou tarde do EXPEDIENTE daquele dia (ex.: quinta 13:00–18:00, sábado 13:00–16:00)
async function shiftOf(
  date: LocalDate,
  shift: "morning" | "afternoon",
): Promise<Interval | null> {
  const blocks = await prisma.workingHours.findMany({
    where: { weekday: weekdayOf(date) },
  });
  const part = blocks.filter((b) =>
    shift === "morning" ? b.startMinute < NOON : b.startMinute >= NOON,
  );
  if (part.length === 0) return null; // ex.: domingo, ou dia sem tarde

  const start = Math.min(...part.map((b) => b.startMinute));
  const end = Math.max(...part.map((b) => b.endMinute));
  return { startsAt: localToUtc(date, start), endsAt: localToUtc(date, end) };
}

// Ela atende nesse dia da semana? (domingo, por exemplo, não)
async function isOpenOn(date: LocalDate): Promise<boolean> {
  const count = await prisma.workingHours.count({
    where: { weekday: weekdayOf(date) },
  });
  return count > 0;
}

// Algum dia do período tem atendimento? (basta olhar até 7 dias: uma semana passa por todos os dias)
async function hasOpenDay(
  start: LocalDate,
  totalDays: number,
): Promise<boolean> {
  for (let i = 0; i < Math.min(totalDays, 7); i++) {
    if (await isOpenOn(addDays(start, i))) return true;
  }
  return false;
}

// Transforma o pedido do painel em intervalos de tempo exatos
async function parseRequest(body: Record<string, unknown>): Promise<Parsed> {
  switch (body.kind) {
    case "day": {
      const date = parseLocalDate(body.date);
      if (!date) return { error: "Data inválida." };
      if (!(await isOpenOn(date)))
        return { error: "Você já não atende nesse dia." };
      return { intervals: [wholeDay(date)] };
    }

    case "days": {
      if (
        !Array.isArray(body.dates) ||
        body.dates.length === 0 ||
        body.dates.length > MAX_SELECTED_DAYS
      ) {
        return { error: `Selecione de 1 a ${MAX_SELECTED_DAYS} dias.` };
      }
      const dates = body.dates.map(parseLocalDate);
      if (dates.some((d) => d === null)) return { error: "Data inválida." };
      return { intervals: (dates as LocalDate[]).map(wholeDay) };
    }

    case "morning":
    case "afternoon": {
      const date = parseLocalDate(body.date);
      if (!date) return { error: "Data inválida." };
      const interval = await shiftOf(date, body.kind);
      if (!interval)
        return { error: "Não há atendimento nesse período do dia." };
      return { intervals: [interval] };
    }

    case "range": {
      const date = parseLocalDate(body.date);
      const from = parseTimeToMinutes(body.from);
      const to = parseTimeToMinutes(body.to);
      if (!date || from === null || to === null || to <= from) {
        return { error: "Horário inválido." };
      }
      if (!(await isOpenOn(date)))
        return { error: "Você já não atende nesse dia." }; 
      return {
        intervals: [
          { startsAt: localToUtc(date, from), endsAt: localToUtc(date, to) },
        ],
      };
    }

    case "period": {
      const start = parseLocalDate(body.startDate);
      const end = parseLocalDate(body.endDate);
      if (!start || !end) return { error: "Datas inválidas." };

      const startsAt = localToUtc(start, 0);
      const endsAt = localToUtc(addDays(end, 1), 0); // inclui o último dia inteiro
      if (endsAt <= startsAt)
        return { error: "A data final precisa ser depois da inicial." };
      if (endsAt.getTime() - startsAt.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
        return {
          error: `O período pode ter no máximo ${MAX_PERIOD_DAYS} dias.`,
        };
      }
      const totalDays = Math.round(
        (endsAt.getTime() - startsAt.getTime()) / DAY_MS,
      );
      if (!(await hasOpenDay(start, totalDays))) {
        return { error: "Você já não atende nesses dias." };
      }
      return { intervals: [{ startsAt, endsAt }] };
    }

    default:
      return { error: "Tipo de bloqueio inválido." };
  }
}

// GET /admin/time-off → bloqueios de hoje em diante
adminTimeOffRouter.get("/", async (_req, res) => {
  const blocks = await prisma.timeOff.findMany({
    where: { endsAt: { gt: new Date() } }, // ainda não terminou
    orderBy: { startsAt: "asc" },
    select: { id: true, startsAt: true, endsAt: true, reason: true },
  });
  res.json(blocks);
});

// POST /admin/time-off   body: { kind, date?, dates?, from?, to?, startDate?, endDate?, reason?, force? }
// Sem force: se tiver cliente marcada → 409 com a lista.
// Com force: cancela essas clientes e cria o bloqueio, tudo junto.
adminTimeOffRouter.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const parsed = await parseRequest(body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const now = new Date();
  if (parsed.intervals.every((i) => i.endsAt <= now)) {
    res.status(400).json({ error: "Esse horário já passou." });
    return;
  }

  // Motivo é opcional e só a Carol vê
  const reason =
    typeof body.reason === "string"
      ? body.reason.trim().slice(0, MAX_REASON_LENGTH) || null
      : null;

  const force = body.force === true;

  // Tudo ou nada: se o bloqueio falhar, ninguém é cancelado
  const result = await prisma.$transaction(async (tx) => {
    // Clientes marcadas (pendentes ou confirmadas) nesses horários
    const conflicts = await tx.appointment.findMany({
      where: {
        status: { in: ["PENDING", "CONFIRMED"] },
        OR: parsed.intervals.map((i) => ({
          startsAt: { lt: i.endsAt },
          endsAt: { gt: i.startsAt },
        })),
      },
      orderBy: { startsAt: "asc" },
      select: CONFLICT_SELECT,
    });

    // Sem force: não mexe em nada, o painel mostra o aviso e ela decide
    if (conflicts.length > 0 && !force) {
      return { conflicts, timeOffs: null };
    }

    if (conflicts.length > 0) {
      await tx.appointment.updateMany({
        where: {
          id: { in: conflicts.map((c) => c.id) },
          status: { in: ["PENDING", "CONFIRMED"] },
        },
        data: { status: "CANCELED" },
      });
    }

    const timeOffs = await tx.timeOff.createManyAndReturn({
      data: parsed.intervals.map((i) => ({ startsAt: i.startsAt, endsAt: i.endsAt, reason })),
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    });

    return { conflicts, timeOffs };
  });

  if (result.timeOffs === null) {
    res.status(409).json({
      error: "Existem clientes marcadas nesse período.",
      conflicts: result.conflicts,
    });
    return;
  }

  // canceled = quem precisa ser avisada no WhatsApp (vazio se não tinha ninguém)
  res.status(201).json({ timeOffs: result.timeOffs, canceled: result.conflicts });
});

// DELETE /admin/time-off/5 → desbloqueia
adminTimeOffRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Bloqueio inválido." });
    return;
  }

  const result = await prisma.timeOff.deleteMany({ where: { id } });
  if (result.count === 0) {
    res.status(404).json({ error: "Bloqueio não encontrado." });
    return;
  }
  res.status(204).end();
});
