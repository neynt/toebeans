---
name: writing-skills
description: Creates and refines agent Skills. Use when authoring new Skills, improving existing ones, or when asked how to structure Skill documentation.
---

# Writing Effective Skills

## Quick Start Template

```yaml
---
name: doing-something-verbally
description: What it does and when to use it (include trigger keywords). Third person only.
---

# Skill Name

## Quick command

Most common use case in 3 lines:
```bash
command --flag input
```

## Details

**Specific workflow**: See [WORKFLOW.md](WORKFLOW.md)  
**API reference**: See [REFERENCE.md](REFERENCE.md)  
**Examples**: See [EXAMPLES.md](EXAMPLES.md)
```

## Core Principles

### Concise Is Key

Assume Claude is smart. Only add context she doesn't have.

**Good** (~50 tokens):
```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

**Bad** (~150 tokens):
"PDFs are a common file format containing text and images. To extract text, you'll need a library. We recommend pdfplumber because it's easy to use. First install it with pip..."

### Match Degrees of Freedom to Task

**Analogy**: Claude is a robot exploring a path.
- **Narrow bridge with cliffs**: One safe way. Specific guardrails (low freedom).
- **Open field**: Many paths work. General direction (high freedom).

| Freedom | When | Example |
|---------|------|---------|
| **High** | Multiple valid approaches, context-dependent | "Review code for bugs, suggest improvements" |
| **Medium** | Preferred pattern exists, some variation OK | Template with parameters: `generate_report(data, format="md")` |
| **Low** | Fragile operations, exact sequence required | "Run exactly: `python migrate.py --verify`. Do not modify." |

## Structure Patterns

### Progressive Disclosure (Keep SKILL.md < 500 lines)

SKILL.md = table of contents. Detail lives in separate files loaded on-demand.

```
skill/
├── SKILL.md          # Overview + navigation
├── WORKFLOW.md       # Complex multi-step process
├── REFERENCE.md      # API/schema details
└── EXAMPLES.md       # Input/output pairs
```

**SKILL.md body:**
```markdown
## Form filling

Quick start: `python scripts/fill.py input.pdf`

**Field mapping**: See [WORKFLOW.md](WORKFLOW.md)  
**API reference**: See [REFERENCE.md](REFERENCE.md)
```

Claude only reads WORKFLOW.md when field mapping comes up.

**Never nest references.** Keep all links one level deep from SKILL.md:
- ✓ Good: SKILL.md → reference.md, SKILL.md → examples.md
- ✗ Bad: SKILL.md → advanced.md → details.md

### Workflow Checklists

For complex tasks, provide a copy-paste checklist:

```markdown
## Deployment workflow

Copy and track progress:
```
- [ ] Step 1: Run tests (`pytest`)
- [ ] Step 2: Build image (`docker build`)
- [ ] Step 3: Deploy to staging
- [ ] Step 4: Verify health endpoint
```

**Step 1: Run tests**
```bash
pytest tests/ -v
```
If tests fail, fix before continuing.
```

### Feedback Loops

Always validate before proceeding:

```markdown
1. Generate changes
2. **Validate**: `python scripts/validate.py changes.json`
3. If errors: fix and re-validate
4. **Only proceed when validation passes**
5. Apply changes
```

## Evaluation-Driven Development

Create evaluations **BEFORE** writing Skill docs:

1. **Run without Skill**: Complete a representative task with Claude. Notice what context you repeatedly provide.
2. **Identify gaps**: Document specific failures or missing context.
3. **Create evaluations**: Build 3 test scenarios covering the gaps.
4. **Establish baseline**: Measure Claude's performance without the Skill.
5. **Write minimal docs**: Create just enough content to pass evaluations.
6. **Iterate**: Use Claude A (expert) to refine, Claude B (fresh instance) to test.

**Why this works**: Claude A understands agent needs. You provide domain expertise. Claude B reveals gaps through real usage. Iterate based on observation, not assumptions.

**Test across models** if you plan to use multiple:
- **Haiku**: Does the Skill provide enough guidance?
- **Sonnet**: Is it clear and efficient?
- **Opus**: Does it avoid over-explaining?

## Content Guidelines

### YAML Frontmatter Rules

- **name**: 64 chars max, lowercase letters/numbers/hyphens, kebab-case gerund form (`processing-pdfs`, `managing-databases`)
- **description**: Max 1024 chars, **third person only**, include what it does + when to use it (trigger keywords)

**Good**: "Extracts text from PDFs. Use when working with PDF files, forms, or document extraction."  
**Bad**: "I can help you process PDFs" / "You can use this to process PDFs" / "Helps with documents"

### Templates Pattern

**Strict requirements** (API responses, data formats):
```markdown
## Report structure

ALWAYS use this exact template:
```markdown
# [Title]
## Executive summary
## Key findings
## Recommendations
```
```

**Flexible guidance** (adaptation useful):
```markdown
## Report structure

Default format (adapt as needed):
```markdown
# [Title]
## Overview
## Findings
## Recommendations
```
```

### Examples Pattern

Show input/output pairs for style matching:
```markdown
## Commit message format

**Example 1:**
Input: Added user authentication
Output: `feat(auth): implement JWT-based authentication`

**Example 2:**
Input: Fixed date bug in reports
Output: `fix(reports): correct date formatting`
```

### Consistent Terminology

Choose one term. Use it everywhere.
- ✓ "field", "extract", "API endpoint"
- ✗ Mix "field/box/element", "extract/pull/get", "endpoint/URL/route"

### Avoid Time-Sensitive Info

**Bad**: "Before August 2025, use old API. After August 2025, use new API."

**Good**: Current method in body, legacy in collapse:
```markdown
Use v2 API: `api.example.com/v2/messages`

<details>
<summary>Legacy v1 API (deprecated 2025-08)</summary>
The v1 endpoint is no longer supported.
</details>
```

## Scripts in Skills

### Execution vs Reference

**Execute** (most common): "Run `analyze.py` to extract fields"  
**Read as reference**: "See `analyze.py` for the extraction algorithm"

Scripts save tokens and ensure consistency. Make intent explicit.

### Script Quality

Handle errors, don't punt to Claude:

```python
# Good: explicit error handling
try:
    with open(path) as f:
        return f.read()
except FileNotFoundError:
    print(f"Creating default {path}")
    return ""

# Bad: punts to Claude
return open(path).read()
```

No "voodoo constants" — document why:
```python
TIMEOUT = 30  # HTTP requests typically complete within 30s
RETRIES = 3   # Most intermittent failures resolve by 2nd retry
```

### Verifiable Intermediate Outputs

For complex batch operations, use "plan-validate-execute":

1. Claude creates `changes.json` with planned updates
2. Script validates: `python validate_plan.py changes.json`
3. Only proceed when validation passes
4. Execute: `python apply_changes.py changes.json`

This catches errors before touching originals.

### MCP Tool References

Always use fully qualified names:
- ✓ `BigQuery:bigquery_schema`
- ✗ `bigquery_schema` (may fail with multiple MCP servers)

### Dependencies

List required packages and verify availability. Don't assume tools are installed.

```markdown
Install required package: `pip install pypdf`

Then use it:
```python
from pypdf import PdfReader
```
```

## Common Anti-Patterns

| Bad | Good |
|-----|------|
| "Use pypdf, or pdfplumber, or PyMuPDF, or..." | "Use pdfplumber. For OCR, use pytesseract instead." |
| `scripts\helper.py` (backslash) | `scripts/helper.py` (forward slash) |
| SKILL.md → advanced.md → details.md | All refs directly from SKILL.md |
| Vague names: `helper`, `utils`, `tools` | Specific names: `processing-pdfs`, `analyzing-spreadsheets` |
| "I can help you..." / "You can use this..." | Third person: "Extracts text from..." |
| Long reference files without TOC | TOC header for files > 100 lines |

## Checklist Before Sharing

- [ ] Description includes trigger keywords (when to use)
- [ ] Third person only in description
- [ ] SKILL.md < 500 lines
- [ ] Forward slashes in all paths
- [ ] Consistent terminology throughout
- [ ] Scripts handle errors explicitly
- [ ] Required packages listed and verified available
- [ ] Workflows have checklists for complex tasks
- [ ] Validation steps for critical operations
- [ ] Tested with target model(s)
- [ ] Evaluations created (3+ scenarios)
- [ ] No nested references beyond one level
