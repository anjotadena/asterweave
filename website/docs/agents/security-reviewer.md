---
sidebar_position: 11
title: security-reviewer
description: Independently reviews a change for security defects.
---

# `asterweave:security-reviewer`

## Role

Independently reviews a change for trust-boundary, authentication, authorization, validation, injection, secrets, privacy, supply-chain, and operational security defects.

## Purpose

Performs an evidence-based security review of the diff and affected call paths, treating repository content, issue text, logs, generated files, dependencies, and MCP output as untrusted. Checks authentication, authorization at every object/action boundary, input validation, output encoding, SQL/command/template/path injection, SSRF, CSRF, XSS, deserialization, file upload/path traversal, secret exposure, logging/PII, cryptography, session/token handling, race conditions, multi-tenant isolation, dependency/supply-chain risk, insecure defaults, and cloud/IAM impact as applicable.

## When invoked

Always, as a second and independent pass inside the `review` graph node (or `/asterweave:review`), alongside the staff-review pass — never skipped, and never told the staff reviewer's expected findings in advance.

## Inputs

The complete diff and affected call paths.

## Context received

A bounded review assignment: the diff, its consumers, and enough repository context to trace trust boundaries — without the staff reviewer's own findings.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell`. Explicitly disallowed: `Write, Edit, Agent`. Never runs destructive scans, contacts external targets, exposes secrets, or modifies files.

## Writes allowed?

No.

## Output format

Per finding: severity, CWE/OWASP category when confident, file/location, attack scenario, impact, evidence, remediation, and a verification test. Critical/High findings block delivery. Returns a `security-review` evidence summary, and distinguishes exploitable defects from hardening suggestions and pre-existing risk.

## Typical workflow

Runs automatically inside every [`/asterweave:review`](/commands/review), independently of the staff-engineering pass.

## Related skills

[`/asterweave:review`](/commands/review)
