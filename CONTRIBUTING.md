# 🧪 Pull Request Guide

This guide explains how you and your team can work with **Pull Requests (PR)** in this repository.
It ensures that all changes are **reviewed and approved** before becoming part of the `main` branch.

---

## 🧭 Step 1: Create a branch or fork the repo

If you're a **collaborator**:
```bash
# Fetch latest code
git pull origin main

# Create a new branch for your work
git checkout -b feature/your-name-change
```

If you **don't have push access**:
1. Click **Fork** in the top-right of the GitHub page.
2. Work in your own copy of the repo.
3. Make changes and open a PR back to the original repo.

---

## 🛠 Step 2: Make your changes

Edit HTML, CSS, JavaScript, or other relevant content. Use meaningful commit messages:
```bash
git add index.html
git commit -m "🧼 Improve tooltip text in the chart"
```

---

## 🚀 Step 3: Push and open a PR

```bash
git push origin feature/your-name-change
```

Then go to GitHub and open a **Pull Request** targeting `main`:
- Give the PR a **clear title and description**
- If required: assign reviewers (or they will be auto-assigned via CODEOWNERS)

---

## ✅ Step 4: Review and merge

1. A reviewer will go through your changes
2. The PR must be approved (at least one person, depending on branch protection rules)
3. Once approved, you (or a maintainer) can merge the PR

---

## 💡 Tips

- Feel free to use emoji in commits and PRs: `🎨`, `🚀`, `🐛`, `🧪`, `✅`
- Group small changes into one PR – split large ones into multiple
- Use the comment thread for questions and suggestions

---

## 🧱 Suggested branch naming (optional)

Use the following naming conventions:
- `feature/name` – new feature or content
- `fix/name` – bug fix
- `docs/name` – documentation

---

## 🤝 Ready to contribute?
1. Follow the guide above 🔼
2. Or ask in Teams if you're unsure
3. We look forward to your contribution 🙌

---

> Maintainer: @Haulund-ATP
