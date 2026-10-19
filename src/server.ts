import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { prisma } from "./lib/prisma.js";
import { adminRouter } from "./routes/admin.js";

const port = 3000;
const app = express();

app.use(cors({ origin: process.env.WEB_URL, credentials: true }));
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser()); 

app.get("/health", async (_, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: "ok", database: "ok" });
    } catch {
        res.status(500).json({ status: "error", database: "unreachable" });
    }
});

app.get("/services", async (_, res) => {
    const services = await prisma.service.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        select: {
        id: true,
        name: true,
        price: true,
        priceIsStartingAt: true,
        durationMinutes: true,
        imageUrl: true,
        },
    });
    res.json(services);
});

app.use("/admin", adminRouter); 

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
