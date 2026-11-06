import type { Env, Mission } from "../types";

export async function consumeMissions(batch: MessageBatch<Mission>, env: Env) {
  for (const msg of batch.messages) {
    try {
      const m = msg.body;
      const supervisorNamespace = env.SUPERVISOR;
      if (!supervisorNamespace) throw new Error("SUPERVISOR Durable Object binding is not configured");
      const supervisorId = supervisorNamespace.idFromName("global-recovery");
      const supervisor = supervisorNamespace.get(supervisorId);
      const res = await supervisor.fetch("https://do/assign-mission", {
        method: "POST",
        body: JSON.stringify(m),
      });
      if (!res.ok) throw new Error(`supervisor ${res.status}`);
      msg.ack();
    } catch { msg.retry(); }
  }
}
