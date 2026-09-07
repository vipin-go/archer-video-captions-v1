#!/usr/bin/env npx tsx

/**
 * Validates a Gabriel Operator workflow JSON file.
 *
 * Usage:
 *   npx tsx server/skills/workflow-builder/scripts/validate-workflow.ts <file.json>
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateLocalPreviewPackage } from './validate-preview-package';

const VALID_ACTION_TYPES = [
  "navigate",
  "click",
  "fill",
  "type",
  "hover",
  "select",
  "scroll",
  "manual_scroll",
  "keypress",
  "keyboard_type",
  "wait",
  "upload",
  "download",
  "screenshot",
  "switch_tab",
  "blank_step",
  "take_control",
  "llm",
  "llm_command",
  "goal",
  "confirmation",
  "manual_extract",
  "continuous_screenshots",
  "image_response",
  "pdf_response",
  "api_call",
  "rest_api",
  "llm_rest_api",
  "mcp_tool",
  "data_source_read",
  "data_source_write",
  "api_output",
  "notification",
  "generate_media",
  "stitch_videos",
  "coding_agent",
  "computer_use_agent",
  "persona_capability",
] as const;

const VALID_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const STEP_ID_PATTERN = /^step-[a-f0-9]{5}$/;
const FORBIDDEN_PORTABLE_KEYS = new Set([
  "appId",
  "endpointId",
  "actionId",
  "pageId",
  "userId",
  "pipelineId",
  "listId",
  "collectionId",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errors: string[] = [];

function err(path: string, message: string): void {
  errors.push(`${path}: ${message}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateNoLocalIds(value: unknown, path = "$" ): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateNoLocalIds(child, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PORTABLE_KEYS.has(key)) {
      err(`${path}.${key}`, "is environment-local and forbidden in schemaVersion 2");
    }
    validateNoLocalIds(child, `${path}.${key}`);
  }
}

function validateWorkflowCanvasBlueprint(canvas: unknown, path: string): void {
  if (!isObject(canvas)) return;
  if (canvas.blueprintRef !== "inline") {
    err(
      `${path}.blueprintRef`,
      "must be inline; page-backed master-skill Canvas is deprecated and must not be authored in workflows",
    );
  }
}

function validateCanvasTaskSequence(canvas: unknown, path: string): void {
  if (!isObject(canvas) || canvas.taskSequence === undefined) return;
  if (!isObject(canvas.taskSequence)) {
    err(`${path}.taskSequence`, "must be an object");
    return;
  }
  const sequence = canvas.taskSequence;
  if (sequence.schemaVersion !== 1 || sequence.type !== "duration_chunked_media") {
    err(`${path}.taskSequence`, "must use schemaVersion 1 and type duration_chunked_media");
  }
  const idFields = [
    "durationInputKey",
    "storyTaskId",
    "storyboardTemplateTaskId",
    "videoTemplateTaskId",
    "stitchTaskId",
  ];
  for (const field of idFields) {
    if (typeof sequence[field] !== "string" || !(sequence[field] as string).trim()) {
      err(`${path}.taskSequence.${field}`, "is required");
    }
  }
  if (sequence.continuity !== "previous_video_last_frame") {
    err(`${path}.taskSequence.continuity`, "must be previous_video_last_frame");
  }
  const numericFields = [
    "defaultDurationSeconds",
    "minDurationSeconds",
    "maxDurationSeconds",
    "segmentDurationSeconds",
  ];
  for (const field of numericFields) {
    if (!Number.isInteger(sequence[field]) || Number(sequence[field]) <= 0) {
      err(`${path}.taskSequence.${field}`, "must be a positive integer");
    }
  }
  const segment = Number(sequence.segmentDurationSeconds);
  const min = Number(sequence.minDurationSeconds);
  const max = Number(sequence.maxDurationSeconds);
  const defaultDuration = Number(sequence.defaultDurationSeconds);
  if (
    Number.isInteger(segment)
    && Number.isInteger(min)
    && Number.isInteger(max)
    && Number.isInteger(defaultDuration)
    && (
      min > defaultDuration
      || defaultDuration > max
      || defaultDuration % segment !== 0
      || min % segment !== 0
      || max % segment !== 0
    )
  ) {
    err(`${path}.taskSequence`, "duration bounds must align to segmentDurationSeconds");
  }
  const tasks = Array.isArray(canvas.taskTypes) ? canvas.taskTypes.filter(isObject) : [];
  const taskIds = new Set(
    tasks.map((task) => typeof task.id === "string" ? task.id : "").filter(Boolean),
  );
  const configuredTaskIds = [
    sequence.storyTaskId,
    sequence.storyboardTemplateTaskId,
    sequence.videoTemplateTaskId,
    sequence.stitchTaskId,
  ].filter((value): value is string => typeof value === "string" && Boolean(value));
  if (new Set(configuredTaskIds).size !== configuredTaskIds.length) {
    err(`${path}.taskSequence`, "task references must be unique");
  }
  for (const field of ["storyTaskId", "storyboardTemplateTaskId", "videoTemplateTaskId", "stitchTaskId"]) {
    const taskId = typeof sequence[field] === "string" ? sequence[field] as string : "";
    if (taskId && !taskIds.has(taskId)) {
      err(`${path}.taskSequence.${field}`, `references missing task "${taskId}"`);
    }
  }
  const stitchTask = tasks.find((task) => task.id === sequence.stitchTaskId);
  const storyboardTask = tasks.find((task) => task.id === sequence.storyboardTemplateTaskId);
  if (
    storyboardTask
    && (!isObject(storyboardTask.execution) || storyboardTask.execution.type !== "tool")
  ) {
    err(`${path}.taskTypes`, "storyboard template must use execution.type tool");
  }
  const videoTask = tasks.find((task) => task.id === sequence.videoTemplateTaskId);
  if (
    videoTask
    && (!isObject(videoTask.execution) || videoTask.execution.type !== "tool")
  ) {
    err(`${path}.taskTypes`, "video template must use execution.type tool");
  }
  if (
    stitchTask
    && (!isObject(stitchTask.execution) || stitchTask.execution.type !== "stitch_videos")
  ) {
    err(`${path}.taskTypes`, "stitch task must use execution.type stitch_videos");
  }
}

const SANDBOX_MODEL_KEYS = [
  "agentModel",
  "textModel",
  "ttsProviderConfigId",
  "ttsModel",
  "ttsVoice",
  "transcriptionModel",
  "imageModel",
  "videoModel",
];

function validateSandboxExecution(execution: Record<string, unknown>, path: string): void {
  if (
    !Array.isArray(execution.skillIds)
    || !execution.skillIds.some((value) => typeof value === "string" && value.trim())
  ) {
    err(`${path}.skillIds`, "must contain at least one skill ID");
  }
  if (
    execution.timeoutSeconds !== undefined
    && (
      typeof execution.timeoutSeconds !== "number"
      || execution.timeoutSeconds < 60
      || execution.timeoutSeconds > 1800
    )
  ) {
    err(`${path}.timeoutSeconds`, "must be between 60 and 1800");
  }
  if (execution.modelProfile !== undefined && !isObject(execution.modelProfile)) {
    err(`${path}.modelProfile`, "must be an object");
  } else if (isObject(execution.modelProfile)) {
    for (const key of SANDBOX_MODEL_KEYS) {
      if (
        execution.modelProfile[key] !== undefined
        && (
          typeof execution.modelProfile[key] !== "string"
          || !(execution.modelProfile[key] as string).trim()
        )
      ) {
        err(`${path}.modelProfile.${key}`, "must be a non-empty model ID");
      }
    }
  }
}

function validateCanvasSandboxTasks(canvas: unknown, path: string): void {
  if (!isObject(canvas) || !Array.isArray(canvas.taskTypes)) return;
  canvas.taskTypes.forEach((task, index) => {
    if (!isObject(task) || !isObject(task.execution) || task.execution.type !== "sandbox_skill_run") return;
    validateSandboxExecution(task.execution, `${path}.taskTypes[${index}].execution`);
  });
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (typeof obj[key] !== "string") {
    err(`${path}.${key}`, `must be a string`);
  }
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (typeof obj[key] !== "number") {
    err(`${path}.${key}`, `must be a number`);
  }
}

function requireArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  if (!Array.isArray(obj[key])) {
    err(`${path}.${key}`, `must be an array`);
    return false;
  }
  return true;
}

function requireObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  if (!isObject(obj[key])) {
    err(`${path}.${key}`, `must be an object`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateStep(
  step: unknown,
  index: number,
  expectedStepNumber: number,
): void {
  const p = `steps[${index}]`;

  if (!isObject(step)) {
    err(p, "must be an object");
    return;
  }

  // step_number
  if (typeof step.step_number !== "number") {
    err(`${p}.step_number`, "must be a number");
  } else if (step.step_number !== expectedStepNumber) {
    err(
      `${p}.step_number`,
      `expected ${expectedStepNumber} but got ${step.step_number} (must be sequential starting from 1)`,
    );
  }

  // action_type
  if (typeof step.action_type !== "string") {
    err(`${p}.action_type`, "must be a string");
  } else if (
    !(VALID_ACTION_TYPES as readonly string[]).includes(step.action_type)
  ) {
    err(
      `${p}.action_type`,
      `invalid value "${step.action_type}", must be one of [${VALID_ACTION_TYPES.join(", ")}]`,
    );
  }

  // stepId
  if (typeof step.stepId !== "string") {
    err(`${p}.stepId`, "must be a string");
  } else if (!STEP_ID_PATTERN.test(step.stepId)) {
    err(
      `${p}.stepId`,
      `invalid format "${step.stepId}", must match /^step-[a-f0-9]{5}$/`,
    );
  }

  // --- Action-specific validations ---

  const actionType = step.action_type as string;

  // rest_api
  if (actionType === "rest_api") {
    if (!isObject(step.restApiConfig)) {
      err(`${p}.restApiConfig`, "must be an object for rest_api steps");
    } else {
      const cfg = step.restApiConfig as Record<string, unknown>;
      if (typeof cfg.method !== "string") {
        err(`${p}.restApiConfig.method`, "must be a string");
      } else if (
        !(VALID_HTTP_METHODS as readonly string[]).includes(cfg.method)
      ) {
        err(
          `${p}.restApiConfig.method`,
          `invalid value "${cfg.method}", must be one of [${VALID_HTTP_METHODS.join(", ")}]`,
        );
      }
      if (typeof cfg.url !== "string" || cfg.url.length === 0) {
        err(`${p}.restApiConfig.url`, "must be a non-empty string");
      }
    }
  }

  // data_source_read
  if (actionType === "data_source_read") {
    if (!isObject(step.dataSourceReadConfig)) {
      err(
        `${p}.dataSourceReadConfig`,
        "must be an object for data_source_read steps",
      );
    } else {
      const cfg = step.dataSourceReadConfig as Record<string, unknown>;
      for (const key of ["connectorId", "kind", "operation"]) {
        if (typeof cfg[key] !== "string" || (cfg[key] as string).length === 0) {
          err(
            `${p}.dataSourceReadConfig.${key}`,
            "must be a non-empty string",
          );
        }
      }
    }
  }

  // data_source_write
  if (actionType === "data_source_write") {
    if (!isObject(step.dataSourceWriteConfig)) {
      err(
        `${p}.dataSourceWriteConfig`,
        "must be an object for data_source_write steps",
      );
    } else {
      const cfg = step.dataSourceWriteConfig as Record<string, unknown>;
      for (const key of ["connectorId", "kind", "operation"]) {
        if (typeof cfg[key] !== "string" || (cfg[key] as string).length === 0) {
          err(
            `${p}.dataSourceWriteConfig.${key}`,
            "must be a non-empty string",
          );
        }
      }
    }
  }

  if (actionType === "persona_capability") {
    if (!isObject(step.personaCapabilityConfig)) {
      err(
        `${p}.personaCapabilityConfig`,
        "must be an object for persona_capability steps",
      );
    } else {
      const cfg = step.personaCapabilityConfig as Record<string, unknown>;
      const kinds = [
        "tool",
        "canvas_task_execution",
        "sandbox_skill_run",
        "workflow_endpoint",
      ];
      if (cfg.schemaVersion !== 1) {
        err(`${p}.personaCapabilityConfig.schemaVersion`, "must be 1");
      }
      if (!kinds.includes(String(cfg.kind || ""))) {
        err(
          `${p}.personaCapabilityConfig.kind`,
          `must be one of: ${kinds.join(", ")}`,
        );
      }
      if (!isObject(cfg.execution)) {
        err(`${p}.personaCapabilityConfig.execution`, "must be an object");
      } else if (cfg.execution.type !== cfg.kind) {
        err(
          `${p}.personaCapabilityConfig.execution.type`,
          "must match personaCapabilityConfig.kind",
        );
      } else if (
        cfg.kind === "tool"
        && (typeof cfg.execution.toolId !== "string" || !cfg.execution.toolId.trim())
      ) {
        err(`${p}.personaCapabilityConfig.execution.toolId`, "is required");
      } else if (
        cfg.kind === "workflow_endpoint"
        && (
          typeof cfg.execution.endpointSlug !== "string"
          || !cfg.execution.endpointSlug.trim()
        )
      ) {
        err(`${p}.personaCapabilityConfig.execution.endpointSlug`, "is required");
      } else if (
        cfg.kind === "canvas_task_execution"
        && !isObject(cfg.execution.canvas)
      ) {
        err(`${p}.personaCapabilityConfig.execution.canvas`, "is required");
      } else if (
        cfg.kind === "sandbox_skill_run"
      ) {
        validateSandboxExecution(
          cfg.execution,
          `${p}.personaCapabilityConfig.execution`,
        );
      }
      if (
        cfg.kind === "canvas_task_execution"
        && isObject(cfg.execution)
        && isObject(cfg.execution.canvas)
      ) {
        validateWorkflowCanvasBlueprint(
          cfg.execution.canvas,
          `${p}.personaCapabilityConfig.execution.canvas`,
        );
        validateCanvasSandboxTasks(
          cfg.execution.canvas,
          `${p}.personaCapabilityConfig.execution.canvas`,
        );
      }
      if (cfg.kind === "canvas_task_execution" && isObject(cfg.canvasTask)) {
        const canvasTask = cfg.canvasTask;
        const taskTypes = isObject(cfg.execution) && isObject(cfg.execution.canvas)
          ? cfg.execution.canvas.taskTypes
          : undefined;
        if (typeof canvasTask.sequenceId !== "string" || !canvasTask.sequenceId.trim()) {
          err(`${p}.personaCapabilityConfig.canvasTask.sequenceId`, "is required");
        }
        if (typeof canvasTask.taskId !== "string" || !canvasTask.taskId.trim()) {
          err(`${p}.personaCapabilityConfig.canvasTask.taskId`, "is required");
        }
        if (!Array.isArray(taskTypes) || taskTypes.length !== 1) {
          err(
            `${p}.personaCapabilityConfig.execution.canvas.taskTypes`,
            "must contain exactly one task for an expanded Canvas step",
          );
        }
        if (
          canvasTask.terminal === true
          && (
            !isObject(canvasTask.aggregateCanvas)
            || !Array.isArray(canvasTask.aggregateCanvas.taskTypes)
            || canvasTask.aggregateCanvas.taskTypes.length !== canvasTask.taskCount
          )
        ) {
          err(
            `${p}.personaCapabilityConfig.canvasTask.aggregateCanvas.taskTypes`,
            "must contain every Canvas task",
          );
        }
        if (canvasTask.terminal === true && isObject(canvasTask.aggregateCanvas)) {
          validateWorkflowCanvasBlueprint(
            canvasTask.aggregateCanvas,
            `${p}.personaCapabilityConfig.canvasTask.aggregateCanvas`,
          );
          validateCanvasTaskSequence(
            canvasTask.aggregateCanvas,
            `${p}.personaCapabilityConfig.canvasTask.aggregateCanvas`,
          );
          validateCanvasSandboxTasks(
            canvasTask.aggregateCanvas,
            `${p}.personaCapabilityConfig.canvasTask.aggregateCanvas`,
          );
        }
      }
    }
  }

  // goal
  if (actionType === "goal") {
    if (typeof step.userPrompt !== "string" || step.userPrompt.length === 0) {
      err(`${p}.userPrompt`, "must be a non-empty string for goal steps");
    }
  }
}

function validateGroups(
  groups: unknown[],
  validStepNumbers: Set<number>,
): void {
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const p = `groups[${i}]`;

    if (!isObject(g)) {
      err(p, "must be an object");
      continue;
    }

    if (typeof g.id !== "string") {
      err(`${p}.id`, "must be a string");
    }
    if (typeof g.name !== "string") {
      err(`${p}.name`, "must be a string");
    }

    if (!Array.isArray(g.stepNumbers)) {
      err(`${p}.stepNumbers`, "must be an array of numbers");
    } else {
      for (let j = 0; j < g.stepNumbers.length; j++) {
        const sn = g.stepNumbers[j];
        if (typeof sn !== "number") {
          err(`${p}.stepNumbers[${j}]`, "must be a number");
        } else if (!validStepNumbers.has(sn)) {
          err(
            `${p}.stepNumbers[${j}]`,
            `references step_number ${sn} which does not exist`,
          );
        }
      }
    }
  }
}

function validateWorkflow(data: unknown): void {
  if (!isObject(data)) {
    err("(root)", "must be an object");
    return;
  }

  if (data.schemaVersion !== undefined && data.schemaVersion !== 1 && data.schemaVersion !== 2) {
    err('schemaVersion', 'must be 1 or 2 when present');
  }
  if (data.schemaVersion === 2 && (typeof data.resourceKey !== 'string' || !data.resourceKey.trim())) {
    err('resourceKey', 'is required for schemaVersion 2');
  }
  if (data.schemaVersion === 2) validateNoLocalIds(data);

  // Top-level keys
  if (!isObject(data.structure)) {
    err("structure", "must be an object");
    return;
  }
  if (typeof data.commitMessage !== "string") {
    err("commitMessage", "must be a string");
  }

  const s = data.structure as Record<string, unknown>;

  // structure fields
  requireString(s, "name", "structure");
  requireString(s, "actionName", "structure");
  if (typeof s.baseUrl !== "string") {
    err("structure.baseUrl", "must be a string");
  }

  if (
    s.autoRecoveryEnabled !== undefined &&
    typeof s.autoRecoveryEnabled !== "boolean"
  ) {
    err("structure.autoRecoveryEnabled", "must be a boolean when present");
  }

  // parameters
  if (!requireObject(s, "parameters", "structure")) {
    // skip
  } else {
    const params = s.parameters as Record<string, unknown>;
    if (!Array.isArray(params.execute)) {
      err("structure.parameters.execute", "must be an array");
    }
  }

  // steps
  const hasSteps = requireArray(s, "steps", "structure");
  const validStepNumbers = new Set<number>();

  if (hasSteps) {
    const steps = s.steps as unknown[];
    for (let i = 0; i < steps.length; i++) {
      validateStep(steps[i], i, i + 1);
      const step = steps[i];
      if (isObject(step) && typeof step.step_number === "number") {
        validStepNumbers.add(step.step_number);
      }
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (
        isObject(step)
        && step.action_type === "persona_capability"
        && isObject(step.personaCapabilityConfig)
        && step.personaCapabilityConfig.kind === "canvas_task_execution"
      ) {
        const canvasTask = step.personaCapabilityConfig.canvasTask;
        const laterEnabledSteps = steps
          .slice(i + 1)
          .filter((candidate) => isObject(candidate) && candidate.skipStep !== true);
        if (isObject(canvasTask)) {
          if (canvasTask.terminal === true && laterEnabledSteps.length > 0) {
            err(
              `steps[${i}]`,
              "terminal canvas persona capability must be the final enabled workflow step",
            );
          } else if (canvasTask.terminal !== true) {
            const next = laterEnabledSteps[0];
            if (
              !isObject(next)
              || next.action_type !== "persona_capability"
              || !isObject(next.personaCapabilityConfig)
              || !isObject(next.personaCapabilityConfig.canvasTask)
              || next.personaCapabilityConfig.canvasTask.sequenceId !== canvasTask.sequenceId
            ) {
              err(
                `steps[${i}]`,
                "expanded Canvas task steps must remain contiguous in the same sequence",
              );
            }
          }
        } else if (laterEnabledSteps.length > 0) {
          err(
            `steps[${i}]`,
            "canvas persona capabilities must be the final enabled workflow step",
          );
        }
      }
    }
  }

  // groups
  if (!requireArray(s, "groups", "structure")) {
    // skip
  } else {
    validateGroups(s.groups as unknown[], validStepNumbers);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(
      "Usage: npx tsx validate-workflow.ts <file.json>",
    );
    process.exit(1);
  }

  const absPath = resolve(filePath);
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (e) {
    console.error(`Error reading file: ${(e as Error).message}`);
    process.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  validateWorkflow(data);
  const commandPath = resolve(dirname(absPath), 'persona-command.json');
  if (existsSync(commandPath)) {
    try {
      const command = JSON.parse(readFileSync(commandPath, 'utf8'));
      if (command.workflowSkill) {
        const packageFingerprint = validateLocalPreviewPackage(resolve(dirname(absPath), '..'), command.workflowSkill);
        console.log(`Workflow preview package: ${packageFingerprint}`);
      }
    } catch (error) { err('workflowSkill', (error as Error).message); }
  }

  if (errors.length > 0) {
    console.error(`Validation failed with ${errors.length} error(s):\n`);
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log("Workflow is valid.");
  process.exit(0);
}

main();
