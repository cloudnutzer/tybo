/**
 * Custom Agent Template
 *
 * Copy this file to create your own specialized agent.
 *
 * Steps:
 * 1. Copy this file: cp custom-agent.example.ts my-agent.ts
 * 2. Update the config (name, reasoning, tools, prompt)
 * 3. Register in src/agents/catalog.ts (BUILTIN_AGENTS and BUILTIN_LOADERS)
 *    Ohne Code: eigene Agenten in config/agents.json (Katalog, Issue #49)
 * 4. Map to a Telegram topic in config/topics.json
 *
 * Reasoning styles:
 * - "ReAct": Reason + Act cycles (good for research)
 * - "CoT": Chain of Thought (good for step-by-step analysis)
 * - "ToT": Tree of Thought (good for exploring multiple options)
 * - "RoT": Recursion of Thought (good for iterative refinement)
 * - "devils-advocate": Challenge and stress-test
 * - "adaptive": Mix based on context
 */

import type { AgentConfig } from "./base";
import { BASE_CONTEXT } from "./base";

const config: AgentConfig = {
  name: "My Custom Agent",
  model: "claude-opus-5-5",
  reasoning: "adaptive",
  // allowedTools: ["Read", "WebSearch"],  // Optional: restrict tools. Omit for full Claude Code access.
  personality: "describe your agent's communication style",
  systemPrompt: `${BASE_CONTEXT}

## MY CUSTOM AGENT ROLE

Describe what this agent does and its area of expertise.

## YOUR EXPERTISE
- Skill 1
- Skill 2
- Skill 3

## THINKING PROCESS
Describe the reasoning framework this agent uses.

## OUTPUT FORMAT
Define how this agent structures its responses.

## CONSTRAINTS
- Constraint 1
- Constraint 2
- Respond in the language the user uses
`,
};

export default config;
