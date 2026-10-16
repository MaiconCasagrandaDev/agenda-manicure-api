import express from "express";
import { prisma } from "./lib/prisma.js";

const port = 3000;
const app = express();

app.use(express.json());

app.get("/health", async (_, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: "ok", database: "ok" });
    } catch {
        res.status(500).json({ status: "error", database: "unreachable" });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
