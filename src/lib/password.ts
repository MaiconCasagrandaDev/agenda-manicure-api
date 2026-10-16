import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Parâmetros atuais: mínimo recomendado pela OWASP para scrypt
const CURRENT = { N: 2 ** 17, r: 8, p: 1 };

// Limites aceitos ao ler um hash do banco (evita valores abusivos)
const LIMITS = { minN: 2 ** 14, maxN: CURRENT.N, maxR: 8, maxP: 4 };

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const INTEGER = /^[1-9]\d{0,9}$/;
const SALT_HEX = new RegExp(`^[0-9a-f]{${SALT_LENGTH * 2}}$`);
const HASH_HEX = new RegExp(`^[0-9a-f]{${KEY_LENGTH * 2}}$`);

type ScryptParams = { N: number; r: number; p: number };

function deriveKey(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        // maxmem precisa ser maior que 128 * N * r, senão o Node recusa
        scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (error, key) => {
        if (error) reject(error);
        else resolve(key);
        });
    });
}

// Formato guardado: scrypt$N$r$p$salt$hash
function parse(stored: string) {
    const parts = stored.split("$");
    if (parts.length !== 6) return null;

    const [algorithm = "", nText = "", rText = "", pText = "", saltHex = "", hashHex = ""] = parts;
    if (algorithm !== "scrypt") return null;
    if (!INTEGER.test(nText) || !INTEGER.test(rText) || !INTEGER.test(pText)) return null;
    if (!SALT_HEX.test(saltHex) || !HASH_HEX.test(hashHex)) return null;

    const N = Number(nText);
    const r = Number(rText);
    const p = Number(pText);

    const isPowerOfTwo = (N & (N - 1)) === 0;
    if (N < LIMITS.minN || N > LIMITS.maxN || !isPowerOfTwo) return null;
    if (r < 1 || r > LIMITS.maxR) return null;
    if (p < 1 || p > LIMITS.maxP) return null;

    return {
        params: { N, r, p },
        salt: Buffer.from(saltHex, "hex"),
        hash: Buffer.from(hashHex, "hex"),
    };
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await deriveKey(password, salt, CURRENT);
    return ["scrypt", CURRENT.N, CURRENT.r, CURRENT.p, salt.toString("hex"), key.toString("hex")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;

    const key = await deriveKey(password, parsed.salt, parsed.params);
    return timingSafeEqual(key, parsed.hash);
}

// Indica se o hash foi salvo com parâmetros antigos (o login regrava com hashPassword)
export function needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return true;
    const { N, r, p } = parsed.params;
    return N !== CURRENT.N || r !== CURRENT.r || p !== CURRENT.p;
}