import { useCallback, useEffect, useState } from "react";

import { listWorkflowSummaries } from "../../workflow/workflow-cli.mjs";

export function useWorkflows(config) {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const summaries = await Promise.resolve(listWorkflowSummaries(config));
      setWorkflows(Array.isArray(summaries) ? summaries : []);
      setError(null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { workflows, loading, error, refresh };
}

export default useWorkflows;
