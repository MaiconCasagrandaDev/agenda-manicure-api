import express from "express";

const port = 3000;
const app = express();

app.use(express.json());

app.get("/health", (_, res) => {
    res.json({ status: "ok" });
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
