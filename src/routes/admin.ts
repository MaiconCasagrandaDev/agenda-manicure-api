import { randomBytes } from "node:crypto";
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { hashPassword, needsRehash, verifyPassword } from "../lib/password.js";
import { createSession, destroySession, requireAdmin } from "../lib/session.js";

export const adminRouter = Router();

// Mesma mensagem para TODO tipo de falha (OWASP): e-mail inexistente,
// senha errada ou conta bloqueada. Quem ataca não descobre nada.
const LOGIN_ERROR = "Não foi possível entrar. Confira o e-mail e a senha ou aguarde alguns minutos.";
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128; // também evita alguém mandar "senhas" gigantes para travar o scrypt

// Hash de uma senha aleatória, calculado uma vez. Quando o e-mail não existe,
// conferimos a senha contra ele para gastar o MESMO tempo de uma conta real.
const dummyHashPromise = hashPassword(randomBytes(16).toString("hex"));

// Bloqueio crescente: 5 erros = 1 min, 10 = 5 min, 15, 20... = 15 min
function lockDurationMs(failedAttempts: number) {
    if (failedAttempts < 5 || failedAttempts % 5 !== 0) return 0;
    if (failedAttempts === 5) return 60_000;
    if (failedAttempts === 10) return 5 * 60_000;
    return 15 * 60_000;
}

// Respostas do painel nunca ficam guardadas no cache do navegador (OWASP)
adminRouter.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
});

adminRouter.post("/login", async (req, res) => {
    const { email, password } = req.body ?? {};

    if (
        typeof email !== "string" || typeof password !== "string" ||
        email.length > MAX_EMAIL_LENGTH ||
        password.length === 0 || password.length > MAX_PASSWORD_LENGTH
    ) {
        res.status(400).json({ error: "Dados inválidos." });
        return;
    }

    const admin = await prisma.adminUser.findUnique({
        where: { email: email.trim().toLowerCase() },
    });

    // Sempre roda o scrypt, exista o e-mail ou não (mesmo tempo de resposta)
    const storedHash = admin?.passwordHash ?? (await dummyHashPromise);
    const passwordOk = await verifyPassword(password, storedHash);

    if (!admin) {
        res.status(401).json({ error: LOGIN_ERROR });
        return;
    }

    // Conta bloqueada: recusa até mesmo a senha certa
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
        res.status(401).json({ error: LOGIN_ERROR });
        return;
    }

    if (!passwordOk) {
        // increment é atômico: duas tentativas ao mesmo tempo não "perdem" a contagem
        const updated = await prisma.adminUser.update({
        where: { id: admin.id },
        data: { failedLoginAttempts: { increment: 1 } },
        });
        const lockMs = lockDurationMs(updated.failedLoginAttempts);
        if (lockMs > 0) {
        await prisma.adminUser.update({
            where: { id: admin.id },
            data: { lockedUntil: new Date(Date.now() + lockMs) },
        });
        }
        res.status(401).json({ error: LOGIN_ERROR });
        return;
    }

    // Senha certa: zera o contador e, se o hash estiver com parâmetros
    // antigos, aproveita que temos a senha em mãos para refazer (rehash)
    await prisma.adminUser.update({
        where: { id: admin.id },
        data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        ...(needsRehash(admin.passwordHash) && { passwordHash: await hashPassword(password) }),
        },
    });

    // Se já existia uma sessão neste navegador, descarta antes de criar outra (OWASP)
    await destroySession(req, res);
    await createSession(res, admin.id);

    res.json({ email: admin.email });
});

// Quem está logado? O front usa para saber se mostra o painel ou o login
adminRouter.get("/me", requireAdmin, (_req, res) => {
    res.json({ email: res.locals.admin.email });
});

adminRouter.post("/logout", async (req, res) => {
    await destroySession(req, res);
    res.status(204).end(); // 204 = deu certo, sem conteúdo
});