# What This Project Is

This is a tool that answers questions about Docker in plain English. You ask a question, and it reads through the real Docker documentation, finds the parts that actually answer your question, and gives you a clear answer along with links to where that answer came from.

## Why We Built It

Docker's documentation is huge. Finding the right page for a specific question takes time. This tool skips that step. You just ask, and it finds the answer for you, backed by real documentation, not guesses.

It also refuses to make things up. If the documentation doesn't cover something, it says so honestly instead of giving a confident-sounding wrong answer.

## How It Works, Simply

1. We take Docker's documentation and break it into small, organized pieces.
2. Each piece is turned into a kind of fingerprint that captures its meaning, and stored in a searchable database.
3. When someone asks a question, we search that database for the pieces that match the meaning of the question best.
4. We hand those pieces to an AI model, which reads them and writes a clear answer, always pointing back to which piece of documentation it used.

Every answer comes with its sources attached, so you can double-check it yourself.

## What Makes This Solid, Not Just a Demo

- **It doesn't guess.** If there isn't enough real information to answer a question, it says so instead of making something up.
- **It's cost-aware.** Every answer tracks exactly how much it cost to generate, so usage is never a mystery.
- **It has limits built in.** If a request would be too large or too expensive, it's stopped before it happens, not after.
- **It's been tested properly.** Over four hundred automated checks run against this project, and it's been tested live with real questions and real answers, not just on paper.
- **It's built in stages.** Reading the docs, organizing them, searching them, and answering questions are all separate steps that can be checked, fixed, or improved one at a time without breaking the rest.
- **It's ready to grow.** New documentation, other tools, or other topics beyond Docker can be added later without rebuilding what's already here.

## Where It Stands Today

The core pipeline works end to end. It's been tested with real Docker questions and gives real, accurate, well-sourced answers. Some polish items remain (a small config file, a wider knowledge set), but the foundation is solid and working.
