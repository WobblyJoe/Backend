# Expense Splitter — Backend

Express REST API with MySQL-compatible TiDB Cloud Serverless.

## Requirements

- Node.js 22 or a compatible supported version
- npm
- A TiDB Cloud Serverless cluster with a public endpoint

## Setup

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env` and enter your TiDB connection details.

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Start the development server:

```bash
npm run dev
```

The API runs at `http://localhost:5000` by default.

The database tables are created automatically when the first API request arrives.

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/groups` | List all groups |
| POST | `/api/groups` | Create a group |
| GET | `/api/groups/:id` | Get group details |
| POST | `/api/groups/:id/expenses` | Add an expense |
| DELETE | `/api/groups/:id/expenses/:eid` | Delete an expense |

## Database Tables

- `grps` — stores groups.
- `members` — stores group members.
- `expenses` — stores expenses.
- `splits` — stores each member's share of an expense.

All monetary amounts are stored as integer paise to avoid floating-point errors.

## Deployment

Deploy this repository to Vercel.

Configure the following environment variables in Vercel:

- `TIDB_HOST`
- `TIDB_PORT`
- `TIDB_USER`
- `TIDB_PASSWORD`
- `TIDB_DATABASE`
- `FRONTEND_URL`

Set `FRONTEND_URL` to the deployed frontend's origin.

## Limitations

This educational project does not include authentication, authorization, or real-money transfers. Add authentication and access controls before using it with private financial data.
