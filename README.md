# Agenda Manicure · API

API do sistema de agendamento online de um estúdio de manicure. As clientes escolhem serviços, dia e horário pelo site, e a profissional aprova, gerencia a agenda e bloqueia horários por um painel.

> 🚧 Projeto em desenvolvimento. O front-end está em [agenda-manicure-web](https://github.com/MaiconCasagrandaDev/agenda-manicure-web).

## O que ela faz

**Para as clientes**
- Lista os serviços com preço e duração
- Calcula os horários livres (expediente, bloqueios, agendamentos e antecedência mínima)
- Recebe pedidos de agendamento, que ficam pendentes até a profissional aprovar

**Para a profissional (painel)**
- Login com sessão segura
- Pedidos pendentes: confirmar ou recusar
- Agenda do dia: lembrete e cancelamento
- Bloqueios: dia inteiro, manhã, tarde, horário específico ou férias, com opção de cancelar as clientes marcadas no período

## Regras de negócio

- Horários em grade de 30 minutos, no fuso de Brasília (`America/Sao_Paulo`)
- Antecedência mínima de 2 horas e agenda aberta para os próximos 30 dias
- Até 3 serviços por agendamento
- Dois agendamentos nunca se sobrepõem: garantido pelo próprio PostgreSQL com uma *exclusion constraint*, não só pelo código
- Preço e nome dos serviços são copiados para o agendamento, para o histórico não mudar se o catálogo mudar

## Segurança

- Sessão guardada no banco (só o hash do token), em cookie `HttpOnly` e `SameSite=Strict`
- Senha com hash scrypt, resposta de erro genérica e tempo constante no login
- Bloqueio progressivo da conta após tentativas erradas e *rate limit* no login, nos agendamentos e na disponibilidade
- Validação de todos os dados recebidos e limite de tamanho no corpo das requisições

## Tecnologias

- Node.js + Express 5
- TypeScript
- Prisma 7 + PostgreSQL
- express-rate-limit, cookie-parser, cors

## Como rodar

Pré-requisitos: Node.js e um PostgreSQL rodando.

```bash
npm install
```

Crie um arquivo `.env` na raiz com a conexão do banco e os dados do admin usados pelo seed (veja `prisma/seed.ts`). **Nunca suba o `.env` para o GitHub.**

```env
DATABASE_URL="postgresql://USUARIO:SENHA@localhost:5433/agenda_manicure"
```

Prepare o banco e rode:

```bash
npx prisma migrate dev     # cria as tabelas
npx prisma generate        # gera o client do Prisma
npx prisma db seed         # cria o admin, os serviços e o expediente
npm run dev                # sobe a API
```

Teste em `GET /health`.

## Rotas principais

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/health` | Verifica se a API e o banco estão no ar |
| GET | `/services` | Lista os serviços |
| GET | `/availability?serviceIds=1,3` | Dias e horários livres para os serviços escolhidos |
| POST | `/appointments` | Cria um pedido de agendamento |
| POST | `/admin/login` | Login da profissional |
| GET | `/admin/me` | Dados da sessão atual |
| POST | `/admin/logout` | Encerra a sessão |
| GET | `/admin/appointments` | Pedidos pendentes (`?view=pending`) ou agenda do dia (`?date=`) |
| PATCH | `/admin/appointments/:id` | Confirmar, recusar ou cancelar |
| POST | `/admin/appointments/:id/reminder` | Registra o envio do lembrete |
| GET | `/admin/time-off` | Lista os bloqueios |
| POST | `/admin/time-off` | Cria um bloqueio |
| DELETE | `/admin/time-off/:id` | Remove um bloqueio |

As rotas `/admin/*` (exceto o login) exigem sessão.

## Próximos passos

- Calendário do mês no painel
- Área "Meus horários" para a cliente, com cancelamento
- Clientes de manutenção (retorno a cada X dias)
- Deploy

---

Desenvolvido por [Maicon Casagranda](https://github.com/MaiconCasagrandaDev) · estudante de Análise e Desenvolvimento de Sistemas.