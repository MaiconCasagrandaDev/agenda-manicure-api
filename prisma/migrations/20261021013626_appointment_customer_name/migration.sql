-- 1. Cria a coluna, ainda aceitando vazio
ALTER TABLE "appointments" ADD COLUMN "customerName" TEXT;

-- 2. Preenche os agendamentos antigos com o nome do cadastro da cliente
UPDATE "appointments" a
SET "customerName" = c."name"
FROM "clients" c
WHERE c."id" = a."clientId";

-- 3. Agora que todos têm nome, torna a coluna obrigatória
ALTER TABLE "appointments" ALTER COLUMN "customerName" SET NOT NULL;