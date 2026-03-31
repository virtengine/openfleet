import { useCallback, useEffect, useState } from "react";

import { taskCreate, taskDelete, taskList, taskUpdate } from "../../task/task-cli.mjs";

async function withMutedConsole(work) {
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = () => {};
  console.info = () => {};
  try {
    return await work();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
}

export function useTasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextTasks = await withMutedConsole(() => taskList());
      setTasks(Array.isArray(nextTasks) ? nextTasks : []);
      setError(null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createTask = useCallback(async (payload) => {
    const created = await withMutedConsole(() => taskCreate(payload));
    await refresh();
    return created;
  }, [refresh]);

  const updateTask = useCallback(async (taskId, patch) => {
    const updated = await withMutedConsole(() => taskUpdate(taskId, patch));
    await refresh();
    return updated;
  }, [refresh]);

  const deleteTask = useCallback(async (taskId) => {
    const deleted = await withMutedConsole(() => taskDelete(taskId));
    await refresh();
    return deleted;
  }, [refresh]);

  return { tasks, loading, error, refresh, createTask, updateTask, deleteTask };
}

export default useTasks;
