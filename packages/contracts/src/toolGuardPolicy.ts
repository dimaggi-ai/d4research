export type ToolGuardPolicyMode = "enforcement" | "shadow";

export type ToolGuardRuleEffect = "deny" | "escalate" | "allow";

export interface ToolGuardPolicyCondition {
  readonly field?: string;
  readonly operator?: string;
  readonly value?: string;
  readonly and?: ReadonlyArray<ToolGuardPolicyCondition>;
  readonly or?: ReadonlyArray<ToolGuardPolicyCondition>;
}

export interface ToolGuardPolicyRule {
  readonly rule_id: string;
  readonly rule_type: string;
  readonly conditions: ToolGuardPolicyCondition;
  readonly effect: ToolGuardRuleEffect;
  readonly citation: { readonly excerpt: string };
}

export interface ToolGuardPolicy {
  readonly policy_id: string;
  readonly name: string;
  readonly version: number;
  readonly status: string;
  readonly mode: ToolGuardPolicyMode;
  readonly scope: {
    readonly tool_names: ReadonlyArray<string>;
    readonly tool_groups: ReadonlyArray<string>;
  };
  readonly rules: ReadonlyArray<ToolGuardPolicyRule>;
}
