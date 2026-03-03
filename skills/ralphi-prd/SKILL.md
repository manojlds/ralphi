---
name: ralphi-prd
description: "Generates structured Product Requirements Documents from feature descriptions. Use when asked to create a PRD, write requirements, plan a feature, or draft a spec."
---

# PRD Generator

Create detailed Product Requirements Documents that are clear, actionable, and suitable for implementation by AI agents.

## Workflow

1. Receive a feature description from the user
2. Ask 3-5 essential clarifying questions (with lettered options)
3. Generate a structured PRD based on answers
4. Save to `tasks/prd-[feature-name].md`

**Important:** Do NOT start implementing. Only create the PRD.

## Step 1: Clarifying Questions

Ask only critical questions where the initial prompt is ambiguous. Focus on:

- **Problem/Goal:** What problem does this solve?
- **Core Functionality:** What are the key actions?
- **Scope/Boundaries:** What should it NOT do?
- **Success Criteria:** How do we know it's done?

Format questions with lettered options so the user can respond with "1A, 2C, 3B":

```
1. What is the primary goal?
   A. Option one
   B. Option two
   C. Option three
   D. Other: [please specify]

2. What is the scope?
   A. Minimal / MVP
   B. Full feature
   C. Other: [please specify]
```

Skip questions the user's prompt already answered clearly.

## Step 2: Generate PRD

After receiving answers, generate a PRD with the following sections.

### 1. Introduction/Overview
Brief description of the feature and the problem it solves.

### 2. Goals
Specific, measurable objectives (bullet list).

### 3. User Stories
Each story needs:
- **Title:** Short descriptive name
- **Description:** "As a [user], I want [feature] so that [benefit]"
- **Acceptance Criteria:** Verifiable checklist

Each story should be small enough to implement in one focused session.

**Format:**
```markdown
### US-001: [Title]
**Description:** As a [user], I want [feature] so that [benefit].

**Acceptance Criteria:**
- [ ] Specific verifiable criterion
- [ ] Another criterion
- [ ] Tests/typecheck/lint passes
```

**Rules for acceptance criteria:**
- Must be verifiable, not vague. "Works correctly" is bad. "Button shows confirmation dialog before deleting" is good.
- For UI stories: always include "Verify in browser" as a criterion.

### 4. Functional Requirements
Numbered list: "FR-1: The system must..."

### 5. Non-Goals (Out of Scope)
What this feature will NOT include.

### 6. Design Considerations (Optional)
UI/UX requirements, existing components to reuse.

### 7. Technical Considerations (Optional)
Known constraints, integration points, performance requirements.

### 8. Success Metrics
How will success be measured?

### 9. Open Questions
Remaining questions or areas needing clarification.

## Writing Guidelines

Write for junior developers and AI agents:
- Be explicit and unambiguous
- Avoid jargon or explain it
- Number requirements for easy reference
- Use concrete examples where helpful

## Output

- **Format:** Markdown (`.md`)
- **Location:** `tasks/`
- **Filename:** `prd-[feature-name].md` (kebab-case)
- Save the file using the create_file tool
