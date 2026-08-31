export type StepUpGate = {
  complete: (approved: boolean) => void;
  promise: Promise<boolean>;
};

export function createStepUpGate(): StepUpGate {
  let complete!: (approved: boolean) => void;
  const promise = new Promise<boolean>((resolve) => { complete = resolve; });
  return { complete, promise };
}
