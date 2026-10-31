import type { AppPlatform, VerdictResult } from './types.js';
import { DDD_CRITERIA } from './types.js';

/** Shared by saved workflow templates and runtime dispatch of older/custom workflows. */
export const DOMAIN_DRIVEN_DESIGN_CONTRACT = `## Domain Driven Design (mandatory for all code changes)
Use Domain Driven Design (DDD) for all application, UI, integration and backend code in scope. Preserve existing behavior while improving the boundaries touched by this change; identify pre-existing violations and avoid unrelated rewrites. Keep the design proportional: a small feature can have a small domain model. Do not invent aggregates, domain events, services, CQRS, or extra layers without a business need.

- Define bounded contexts and a ubiquitous language shared by product requirements, BDD scenarios, domain types and API contracts. Organize each context around business capabilities rather than technical tables or screens. State ownership and integration contracts between contexts; do not reach into another context's persistence or internal models.
- Put business rules and invariants in framework-independent domain models (entities, value objects, aggregates or domain services as needed). Enforce invariants through meaningful operations; DTO validation and UI validation cannot be their only enforcement. Define consistency and transaction boundaries where writes cross records.
- Keep domain code independent of SwiftUI, Android/Compose, React, Supabase, HTTP, storage, and other framework SDKs. Application use cases orchestrate domain operations through domain-owned or application-owned ports. Infrastructure adapters implement repository/integration ports and translate persistence models and DTOs. UI components and ViewModels call use cases rather than owning business rules or querying Supabase directly. Dependencies point inward toward the domain.
- For SwiftUI use pure Swift domain types; for Android use pure Kotlin domain types; for React use framework-independent TypeScript/JavaScript domain modules. Share domain vocabulary and observable rules across platforms, while preserving idiomatic implementations. The shared Supabase backend is an infrastructure boundary: keep SQL constraints, RLS and atomic database operations for integrity/authorization, and keep business workflows out of view code and generic persistence wrappers.
- Planning (including Fast Track's brief plan) must document a Domain model section with bounded contexts, vocabulary, invariants, use cases, port/adapter ownership, dependency direction, cross-platform/backend contracts, and the files and tests that enforce them. BDD scenarios exercise observable domain behavior and invalid state transitions using the same vocabulary.
- Implementation and feedback passes must follow that domain model, keep business rules out of views/SDK adapters, add isolated domain/use-case tests and adapter integration tests, and include domain boundaries and contracts in platform handoffs. Review slicing must preserve these boundaries and tests.
- Adversarial review must inspect the actual dependency graph, domain invariants and context integration paths. Report violations with file/line evidence and a regression test. Folder names alone are not evidence of DDD.
- Verification must inspect source dependencies and run domain/invariant tests plus relevant architecture and adapter integration checks. Return NO_GO for material DDD violations or blocked verification. In the readiness report, include a Domain Driven Design matrix with files, observed dependencies, test commands and outcomes. Return dddChecks with one passed entry for EACH criterion in EACH required scope: bounded-contexts, domain-isolation, invariants, dependency-direction, domain-tests. Every entry needs concrete evidence; failed, blocked or missing entries prevent GO. For scopes untouched by the feature, cite the inspected boundaries and explain why no changes are required.

Required DDD verification scopes (repository names for general code workflows; selected platform folders and supabase for mobile apps):
{{ddd_scopes}}`;

export function domainDrivenDesignScopes(repos: string[], mobilePlatforms?: AppPlatform[]): string[] {
  if (!repos.length) return [];
  return mobilePlatforms ? [...mobilePlatforms, 'supabase'] : [...new Set(repos)];
}

/** Validates reported architectural evidence; code inspection and test execution belong to the verifier. */
export function domainDrivenDesignGate(result: VerdictResult, scopes: string[]): string | null {
  for (const scope of scopes) {
    for (const criterion of DDD_CRITERIA) {
      const checks = result.dddChecks?.filter((check) => check.scope === scope && check.criterion === criterion) ?? [];
      if (checks.length !== 1 || checks[0]!.status !== 'passed' || !checks[0]!.evidence.trim()) {
        return `DDD criterion ${criterion} must pass for ${scope} with concrete architectural and test evidence`;
      }
    }
  }
  return null;
}
