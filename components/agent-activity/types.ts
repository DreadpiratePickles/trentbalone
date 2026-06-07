export type ActivityStepStatus = "pending" | "running" | "completed" | "failed" | "waiting";

export type ActivityStepIcon =
  | "read"
  | "write"
  | "command"
  | "test"
  | "verify"
  | "preview"
  | "plan"
  | "status"
  | "error"
  | "approval"
  | "done"
  | "narration";

export type ActivityCodeBlock = {
  filename?: string;
  language?: string;
  content: string;
  mode?: "code" | "diff";
  previousContent?: string;
};

export type ActivityStep = {
  id: string;
  verb: string;
  target?: string;
  chip?: string;
  status: ActivityStepStatus;
  icon?: ActivityStepIcon;
  narration?: string;
  code?: ActivityCodeBlock;
};

export type ActivityFeedProps = {
  steps: ActivityStep[];
  live?: boolean;
  narration?: string;
  className?: string;
  "aria-label"?: string;
};
