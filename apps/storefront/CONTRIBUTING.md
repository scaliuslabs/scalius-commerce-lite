# Contributing to Scalius Commerce Storefront

First off, thank you for considering contributing to the Scalius Commerce Storefront! It's people like you that make the open-source community such an amazing place to learn, inspire, and create.

We welcome contributions of all forms, including bug reports, feature requests, documentation improvements, and code changes.

## ⚖️ Legal & Licensing

### MIT License

This project is licensed under the **MIT License**. By contributing to this repository, you agree that your contributions will be licensed under its terms. This allows for broad freedom in using and adapting the frontend code.

### Contributor License Agreement (CLA)

To ensure we can continue to offer both open-source and proprietary versions of Scalius products, we require all contributors to sign a **Contributor License Agreement (CLA)**.

- **What this means:** You retain ownership of your code, but you grant Scalius the right to use, relicense, and distribute your contributions in our proprietary products without restriction.
- **The Process:** When you submit a Pull Request, a bot will automatically check if you have signed the CLA. If not, it will provide a link for you to sign it digitally. It takes less than a minute.

## 🛠 Project Architecture

This is a **Storefront** application built with modern web technologies:

1.  **Framework:** Astro 6 (SSR + Static)
2.  **UI Library:** React 19
3.  **Styling:** Tailwind CSS v4
4.  **State Management:** Nanostores
5.  **Components:** shadcn/ui

It connects to the **Scalius Commerce Lite** backend for data and commerce logic.

## 🚀 Getting Started

### Prerequisites

- **Node.js** (Latest LTS recommended)
- **pnpm** (We use pnpm for package management)
- **Scalius Commerce Lite Backend** (Local or Remote instance)

### Local Setup

1.  **Fork and Clone**
    Fork the repository to your GitHub account, then clone it locally:

    ```bash
    git clone https://github.com/YOUR_USERNAME/scalius-commerce-storefront.git
    cd scalius-commerce-storefront
    ```

2.  **Run Local Setup From The Repo Root**

    ```bash
    pnpm dev:setup
    ```

    This installs dependencies, creates `.dev.vars` files for API/admin/storefront, creates `.env.development` only for admin and storefront build-time public values, applies local D1 migrations, and creates the default local admin. The generated API token, JWT secret, and purge token are shared across the API/storefront files automatically.

3.  **Run Storefront Development**
    ```bash
    pnpm dev:storefront
    ```
    The storefront runs at `http://localhost:4322`; the local API runs at `http://localhost:8787`. Use `pnpm dev` when you also want the admin dashboard.

## 💻 Development Workflow

1.  **Create a Branch**
    Create a new branch for your feature or fix.

    ```bash
    git checkout -b feature/new-cart-design
    # or
    git checkout -b fix/mobile-menu-bug
    ```

2.  **Make Changes**
    - **Components:** Build reusable UI components in `src/components`.
    - **Pages:** Add or modify routes in `src/pages`.
    - **Global Styles:** Edit `src/styles/global.css` for Tailwind configuration if needed.

3.  **Test Your Changes**
    - Ensure the UI looks good on both Desktop and Mobile.
    - Verify interactions with the backend (Add to cart, Checkout, etc.).

4.  **Commit**
    We encourage using **Conventional Commits** messages:
    - `feat: add sticky header`
    - `fix: resolve mobile overflow issue`
    - `style: improve product card typography`

5.  **Push and Open a PR**
    Push your branch to your fork and submit a Pull Request to the `main` branch of this repository.

## 📋 Coding Standards

- **TypeScript:** We use TypeScript for everything. Please do not use `any` unless absolutely necessary.
- **Formatting:** We use Prettier. Ensure your editor is configured to format on save, or run `pnpm format` (if available).
- **Tailwind:** Use utility classes for styling. Avoid writing custom CSS unless for complex animations.

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
