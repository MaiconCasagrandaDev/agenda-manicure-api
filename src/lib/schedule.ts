import { prisma } from "./prisma.js";

export const TIME_ZONE = "America/Sao_Paulo";

// Regras PROVISÓRIAS — trocar quando a manicure responder
export const SLOT_INTERVAL_MINUTES = 30; // horários de 30 em 30 minutos
export const MIN_NOTICE_MINUTES = 120; // antecedência mínima: 2 horas
export const MAX_DAYS_AHEAD = 30; // agenda aberta para os próximos 30 dias

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_SERVICES = 3; // até 3 serviços por horário
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/; // "2026-10-21"
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/; // "14:00"

export type LocalDate = { year: number; month: number; day: number };

// "2026-10-21" → { year: 2026, month: 10, day: 21 } (ou null se inválida)
export function parseLocalDate(value: unknown): LocalDate | null {
  if (typeof value !== "string") return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Recusa datas impossíveis, como 31 de fevereiro
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;

  return { year, month, day };
}

// "14:30" → 870 (minutos desde a meia-noite, mesmo formato do working_hours)
export function parseTimeToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 0 = domingo, 1 = segunda ... 6 = sábado (padrão do JavaScript)
export function weekdayOf(date: LocalDate) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  timeZoneName: "longOffset", // ex.: "GMT-03:00"
});

// Diferença (em minutos) entre o horário de Brasília e o UTC num instante: ex. -180
function offsetMinutesAt(instant: number): number {
  const name = offsetFormatter
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;

  if (name === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? "");
  // Formato inesperado: melhor falhar do que gravar horário 3h errado
  if (!match) throw new Error(`Fuso horário em formato inesperado: ${name}`);

  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

// "21/10/2026 às 14:00 em Brasília" → instante UTC (2026-10-21T17:00:00Z)
export function localToUtc(date: LocalDate, minuteOfDay: number): Date {
  const wallClock = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    0,
    minuteOfDay,
  );
  let utc = wallClock - offsetMinutesAt(wallClock) * 60_000;
  // 2ª passada: corrige o caso raro de cair bem na troca de horário de verão
  utc = wallClock - offsetMinutesAt(utc) * 60_000;
  return new Date(utc);
}

export type SlotResult =
  | { ok: true; startsAt: Date; endsAt: Date }
  | { ok: false; error: string };

// Confere tudo sobre o horário, MENOS a sobreposição com outros agendamentos
// (essa quem garante é o banco, com a restrição appointments_no_overlap)
export async function validateSlot(
  date: LocalDate,
  startMinute: number,
  durationMinutes: number,
): Promise<SlotResult> {
  if (startMinute % SLOT_INTERVAL_MINUTES !== 0) {
    return { ok: false, error: "Horário inválido." };
  }

  const endMinute = startMinute + durationMinutes;
  const startsAt = localToUtc(date, startMinute);
  const endsAt = localToUtc(date, endMinute);
  const now = Date.now();

  if (startsAt.getTime() < now + MIN_NOTICE_MINUTES * 60_000) {
    return {
      ok: false,
      error: "Esse horário já passou ou está muito próximo. Escolha outro.",
    };
  }
  if (startsAt.getTime() > now + MAX_DAYS_AHEAD * DAY_MS) {
    return {
      ok: false,
      error: `Só é possível agendar com até ${MAX_DAYS_AHEAD} dias de antecedência.`,
    };
  }

  // O atendimento inteiro precisa caber num MESMO bloco do expediente
  // (ex.: não pode começar 11:30 e invadir o almoço das 12:00)
  const blocks = await prisma.workingHours.findMany({
    where: { weekday: weekdayOf(date) },
  });
  const fits = blocks.some(
    (b) => startMinute >= b.startMinute && endMinute <= b.endMinute,
  );
  if (!fits) {
    return { ok: false, error: "Esse horário está fora do atendimento." };
  }

  // Folga ou bloqueio que encosta nesse intervalo?
  const timeOff = await prisma.timeOff.findFirst({
    where: { startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
  });
  if (timeOff) {
    return { ok: false, error: "Esse horário não está disponível." };
  }

  return { ok: true, startsAt, endsAt };
}

const pad = (n: number) => String(n).padStart(2, "0");

// { 2026, 10, 21 } → "2026-10-21"
export function formatLocalDate(date: LocalDate) {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

// 870 → "14:30"
export function minutesToTime(minutes: number) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// Soma dias no calendário (o Date.UTC cuida da virada de mês e de ano)
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

const dateInBrazilFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Que dia é HOJE em Brasília? (o servidor pode estar em outro fuso)
export function todayInBrazil(instant = Date.now()): LocalDate {
  const parts = dateInBrazilFormatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

type Block = { weekday: number; startMinute: number; endMinute: number };
type Busy = { startsAt: Date; endsAt: Date };

export type AvailableDay = { date: string; weekday: number; slots: string[] };

// Calcula os horários livres dos próximos dias.
// Função "pura": só faz contas com o que recebe, sem acessar o banco
// (por isso é fácil de testar).
export function listAvailableDays(params: {
  durationMinutes: number;
  blocks: Block[]; // expediente
  busy: Busy[]; // folgas + agendamentos não cancelados
  now: number;
}): AvailableDay[] {
  const { durationMinutes, blocks, busy, now } = params;
  const earliest = now + MIN_NOTICE_MINUTES * 60_000;
  const latest = now + MAX_DAYS_AHEAD * DAY_MS;
  const today = todayInBrazil(now);
  const days: AvailableDay[] = [];

  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const date = addDays(today, i);
    const weekday = weekdayOf(date);
    const dayBlocks = blocks
      .filter((b) => b.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute);

    if (dayBlocks.length === 0) continue; // dia fechado (ex.: domingo): nem aparece

    const slots: string[] = [];
    for (const block of dayBlocks) {
      // Começa no primeiro horário "redondo" do bloco (de 30 em 30 min)
      const first =
        Math.ceil(block.startMinute / SLOT_INTERVAL_MINUTES) *
        SLOT_INTERVAL_MINUTES;

      // O atendimento inteiro precisa caber no bloco
      for (
        let start = first;
        start + durationMinutes <= block.endMinute;
        start += SLOT_INTERVAL_MINUTES
      ) {
        const startsAt = localToUtc(date, start).getTime();
        const endsAt = localToUtc(date, start + durationMinutes).getTime();

        if (startsAt < earliest || startsAt > latest) continue; // cedo demais ou longe demais

        const taken = busy.some(
          (b) => b.startsAt.getTime() < endsAt && b.endsAt.getTime() > startsAt,
        );
        if (!taken) slots.push(minutesToTime(start));
      }
    }

    days.push({ date: formatLocalDate(date), weekday, slots });
  }

  return days;
}
