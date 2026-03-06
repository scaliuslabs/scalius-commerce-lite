# Contributing to Scalius Commerce Lite

First off, thank you for considering contributing to Scalius Commerce Lite! It's people like you that make the open-source community such an amazing place to learn, inspire, and create.

We welcome contributions of all forms, including bug reports, feature requests, documentation improvements, and code changes.

## ⚖️ Legal & Licensing

### AGPL v3 License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL v3)**. By contributing to this repository, you agree that your contributions will be licensed under its terms.

### Contributor License Agreement (CLA)

To ensure we can continue to offer both open-source and proprietary versions of Scalius products, we require all contributors to sign a **Contributor License Agreement (CLA)**.

- **What this means:** You retain ownership of your code, but you grant Scalius the right to use, relicense, and distribute your contributions in our proprietary products without restriction.
- **The Process:** When you submit a Pull Request, a bot will automatically check if you have signed the CLA. If not, it will provide a link for you to sign it digitally. It takes less than a minute.

## 🛠 Project Architecture

Before diving in, please understand that this is a **hybrid** application:

1.  **Admin Dashboard (Astro + React):** Located in `src/pages/admin` and `src/components/admin`.
2.  **Storefront API (Hono):** Located in `src/server`. This is mounted via an Astro integration.
3.  **Database (Cloudflare D1 + Drizzle ORM):** We use Drizzle ORM with Cloudflare D1 (SQLite).

## 🚀 Getting Started

### Prerequisites

- **Node.js** (Latest LTS recommended)
- **pnpm** (We use pnpm for package management)
- **Cloudflare account** (for D1, KV, R2 bindings when using `pnpm start` for local dev)

### Local Setup

1.  **Fork and Clone**
    Fork the repository to your GitHub account, then clone it locally:

    ```bash
    git clone https://github.com/YOUR_USERNAME/scalius-commerce-lite.git
    cd scalius-commerce-lite
    ```

2.  **Initial Local Setup**

    ```bash
    pnpm dev:setup
    ```

    This installs dependencies, creates `.dev.vars` and `.env.development`, and applies local D1 migrations.

3.  **Environment Variables**
    - `.dev.vars` is for Worker runtime secrets and URL overrides. Use `.dev.vars.example` if you need to create it manually.
    - `.env.development` is for Vite/Astro build-time vars. Use `.env.example` as the template.

4.  **Run Development Server**

    ```bash
    pnpm dev
    ```

    The app should be running at `http://localhost:4321`.

5.  **Optional Reset / Migration Commands**
    ```bash
    pnpm db:migrate:local
    pnpm dev:reset
    ```
    Use `pnpm db:migrate:remote` for remote D1 migrations.

## 💻 Development Workflow

1.  **Create a Branch**
    Create a new branch for your feature or fix.

    ```bash
    git checkout -b feature/amazing-feature
    # or
    git checkout -b fix/annoying-bug
    ```

2.  **Make Changes**
    - **Backend/API:** If modifying the API, work within `src/server`. Remember to update the OpenAPI spec if you change routes.
    - **Database:** If you change `src/db/schema.ts`, run `pnpm db:generate` to create the migration files.
    - **Frontend:** We use Tailwind CSS v4 and shadcn/ui. Keep components small and reusable.

3.  **Test Your Changes**
    - Ensure the Admin UI (`/admin`) loads and functions.
    - Test API endpoints via Swagger UI (`/api/v1/docs`).

4.  **Commit**
    We encourage using **Conventional Commits** messages:
    - `feat: add new widget builder`
    - `fix: resolve order calculation error`
    - `docs: update API documentation`

5.  **Push and Open a PR**
    Push your branch to your fork and submit a Pull Request to the `main` branch of this repository.

## 📋 Coding Standards

- **TypeScript:** We use TypeScript for everything. Please do not use `any` unless absolutely necessary.
- **Formatting:** Run `pnpm format` (if available) or ensure your editor uses Prettier.
- **API Design:** If adding new Hono routes, ensure they are typed and include OpenAPI descriptions in the route definition.

## 🐞 Reporting Issues

If you find a bug, please create an issue using the provided templates. Include:

- Steps to reproduce.
- Expected vs. actual behavior.
- Screenshots (if it's a UI issue).

## 🤝 Code of Conduct

Please note that this project is released with a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.

## ❓ Questions?

If you have questions about the codebase, feel free to open a Discussion on GitHub or contact the maintainers.

Happy Coding! 🚀
