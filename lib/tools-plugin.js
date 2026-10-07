// junior-dev preset row: registers the jd_* tools in the scope of agents on the junior-dev preset.
import { ALL_TOOLS } from './host/tools.js';

export const name = 'junior-dev-tools';

export const inject = ['tools'];

export function apply(ctx) {
  for (const def of ALL_TOOLS) {
    ctx.effect(() => ctx.tools.register(def), `junior-dev tool ${def.name}`);
  }
}
