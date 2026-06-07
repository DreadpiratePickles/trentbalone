# Trent Company Data Package

Use Trent to run Trent. This directory contains everything needed to bootstrap
the Trent company profile inside the Trent app itself.

## Structure

```
trent-company-data/
├── README.md                    ← you are here
├── settings.md                  ← fill in the Settings page with these values
├── memory/                      ← upload all .md files in this folder to Memory
│   ├── 01-company-overview.md
│   ├── 02-icp-and-gtm.md
│   ├── 03-product-spec.md
│   ├── 04-tech-stack.md
│   ├── 05-team-and-roles.md
│   ├── 06-pricing-and-billing.md
│   └── 07-brand-guidelines.md
├── vault/                       ← create these notes inside Vault
│   ├── product/
│   │   ├── roadmap.md
│   │   └── feature-flags.md
│   ├── engineering/
│   │   ├── architecture.md
│   │   └── deploy-runbook.md
│   └── go-to-market/
│       ├── positioning.md
│       └── launch-checklist.md
└── prompts/                     ← test prompts for every section
    └── section-prompts.md
```
