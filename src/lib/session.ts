import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import { prisma } from "./prisma.js";

const isProduction = process.env.NODE_ENV === "production";

// Em produção, o prefixo __Host- obriga o navegador a só aceitar o cookie
// se ele for Secure, sem Domain e com Path=/ (recomendação da OWASP).
// Em desenvolvimento (http://localhost, sem HTTPS) o prefixo não funciona.
export const SESSION_COOKIE = isProduction ? "__Host-admin_session" : "admin_session";

const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 7 * DAY_MS;      // opção B: 7 dias sem uso
const ABSOLUTE_TIMEOUT_MS = 30 * DAY_MS; // opção B: 30 dias no máximo
const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // atualiza o "último uso" no máximo 1x por hora

// As mesmas opções na hora de criar e de apagar o cookie
// (o Express 5 só apaga se forem idênticas)
const COOKIE_OPTIONS: CookieOptions = {
    httpOnly: true,       // JavaScript da página não consegue ler
    secure: isProduction, // só HTTPS em produção
    sameSite: "strict",   // outros sites não conseguem usar o cookie
    path: "/",
};

// O código do cookie tem 256 bits aleatórios. Com essa força, um SHA-256
// é suficiente para guardar no banco (não precisa do scrypt, que é para senhas).
function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
}

function readToken(req: Request): string | null {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    // Ignora cookie ausente ou com tamanho absurdo (lixo ou ataque)
    if (typeof token !== "string" || token.length === 0 || token.length > 100) return null;
    return token;
}

// Cria uma sessão nova e entrega o cookie ao navegador
export async function createSession(res: Response, adminUserId: number) {
    const token = randomBytes(32).toString("base64url"); // 32 bytes = 256 bits
    const expiresAt = new Date(Date.now() + ABSOLUTE_TIMEOUT_MS);

    await prisma.adminSession.create({
        data: { adminUserId, tokenHash: hashToken(token), expiresAt },
    });

    res.cookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, expires: expiresAt });
}

// Descobre quem está logado a partir do cookie (ou null se ninguém)
export async function getSession(req: Request) {
    const token = readToken(req);
    if (!token) return null;

    const session = await prisma.adminSession.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { adminUser: { select: { id: true, email: true } } },
    });
    if (!session) return null;

    const now = Date.now();
    const expired = session.expiresAt.getTime() <= now;
    const idle = session.lastUsedAt.getTime() + IDLE_TIMEOUT_MS <= now;

    if (expired || idle) {
        // deleteMany não dá erro se outra requisição já tiver apagado
        await prisma.adminSession.deleteMany({ where: { id: session.id } });
        return null;
    }

    // Renova o relógio dos 7 dias, sem escrever no banco a cada clique
    if (now - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
        await prisma.adminSession.updateMany({
            where: { id: session.id },
            data: { lastUsedAt: new Date(now) },
        });
    }

    return session;
}

// Logout: apaga a sessão no banco (o mais importante) e limpa o cookie
export async function destroySession(req: Request, res: Response) {
    const token = readToken(req);
    if (token) {
        await prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
}

// "Porteiro" das rotas do painel: só passa quem tem sessão válida
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const session = await getSession(req);
    if (!session) {
        res.status(401).json({ error: "Não autenticado" });
        return;
    }
    res.locals.admin = session.adminUser; // as próximas funções sabem quem é
    next();
}