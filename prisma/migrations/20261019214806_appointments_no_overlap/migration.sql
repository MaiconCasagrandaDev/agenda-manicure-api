-- O fim do horário precisa ser depois do início
ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_ends_after_starts"
    CHECK ("endsAt" > "startsAt");

-- Dois agendamentos (não cancelados) nunca podem se sobrepor.
-- tsrange(início, fim) = intervalo [início, fim): um pode começar
-- exatamente quando o outro termina.
ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_no_overlap"
    EXCLUDE USING gist (tsrange("startsAt", "endsAt") WITH &&)
    WHERE ("status" <> 'CANCELED');