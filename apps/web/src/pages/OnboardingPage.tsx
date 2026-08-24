import { useState } from "react";

import { createWorkspace } from "../lib/api.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Input, Label } from "../components/ui/Input.js";
import { ErrorBanner, InfoBanner, RouteLayout } from "../components/Layout.js";
import type { WorkspacePlan } from "../types.js";

const selectClass =
  "w-full border border-line bg-white rounded-input px-4 py-3 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function OnboardingPage(props: {
  sessionNotice: string | null;
  onCreated: (workspaceId: string) => void;
}) {
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<WorkspacePlan>("growth");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <RouteLayout
      title="Start Your First Growth Workspace"
      subtitle="Create the workspace that will own your templates, runs, approvals, and memory."
    >
      <Card>
        <form
          className="grid gap-4 max-w-3xl"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setIsSubmitting(true);

            try {
              if (!name.trim()) {
                throw new Error("Workspace Name is required");
              }

              const workspace = (await createWorkspace({ name, plan })) as { id: string };
              props.onCreated(workspace.id);
            } catch (error) {
              setError(error instanceof Error ? error.message : "Failed to create workspace");
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <InfoBanner message={props.sessionNotice} />
          <ErrorBanner error={error} />
          <Label>
            <span>Workspace Name</span>
            <Input
              data-testid="workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Growth Lab"
            />
          </Label>
          <Label>
            <span>Plan</span>
            <select
              value={plan}
              onChange={(event) => setPlan(event.target.value as WorkspacePlan)}
              className={selectClass}
              aria-label="Plan"
            >
              <option value="growth">Growth</option>
              <option value="starter">Starter</option>
            </select>
          </Label>
          <Button
            data-testid="create-workspace"
            type="submit"
            disabled={isSubmitting}
            aria-label={isSubmitting ? "Creating workspace" : "Create workspace"}
          >
            {isSubmitting ? "Creating..." : "Create Workspace"}
          </Button>
        </form>
      </Card>
    </RouteLayout>
  );
}
