import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/**
 * 节点业务执行体：返回需合并到全局状态的增量（Partial<State>）。
 * 引擎负责不可变合并与跳转；节点自身不应修改传入的 state。
 */
export type NodeHandler<TState = any> = (
  state: TState,
  ctx: Context,
) => Promise<Partial<TState>> | Partial<TState>;

/**
 * 动态路由判断：返回下一个目标 NodeName，或返回 "__END__" 终止图执行。
 */
export type ConditionHandler<TState = any> = (
  state: TState,
  ctx: Context,
) => string | Promise<string>;

/** 图执行终止哨兵（与静态边 / 条件路由共用）。 */
export const END = "__END__";

export interface GraphDefinition<TState = any> {
  nodes: Map<string, NodeHandler<TState>>;
  edges: Map<string, string>;
  conditionalEdges: Map<string, ConditionHandler<TState>>;
  entryPoint?: string;
  maxIterations: number;
}

/** 图执行完成后的最终产物及全量跳转轨迹。 */
export interface GraphExecutionResult<TState = any> {
  finalState: TState;
  trajectory: string[];
  iterations: number;
}

// ---- dsh 追加式 Trajectory 事件总线（graph/* 事件载荷） ----

export interface GraphStartEvent<TState = any> {
  initialState: TState;
  entryPoint: string;
}

export interface GraphNodeStartEvent<TState = any> {
  node: string;
  state: TState;
  iteration: number;
}

export interface GraphNodeEndEvent<TState = any> {
  node: string;
  state: TState;
}

export interface GraphNodeErrorEvent {
  node: string;
  error: unknown;
}

export interface GraphErrorEvent<TState = any> {
  error: Error;
  state: TState;
  lastNode: string;
}

export interface GraphEndEvent<TState = any> {
  finalState: TState;
  trajectory: string[];
  iterations: number;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** StateGraph 编排引擎服务：创建隔离的状态图实例。 */
    graph: GraphEngineService;
  }

  interface Events {
    "graph/start"(event: GraphStartEvent): void;
    "graph/node-start"(event: GraphNodeStartEvent): void;
    "graph/node-end"(event: GraphNodeEndEvent): void;
    "graph/node-error"(event: GraphNodeErrorEvent): void;
    "graph/error"(event: GraphErrorEvent): void;
    "graph/end"(event: GraphEndEvent): void;
  }
}

/**
 * 有向状态图运行时内核：节点注册、静态边/条件路由、迭代熔断与轨迹留存。
 *
 * 节点只返回状态增量（Patch），引擎做浅拷贝合并；回环由 maxIterations
 * 熔断，超限抛错并发出 graph/error 事件。
 */
export class StateGraph<TState extends Record<string, any>> {
  private def: GraphDefinition<TState> = {
    nodes: new Map(),
    edges: new Map(),
    conditionalEdges: new Map(),
    maxIterations: 25,
  };

  constructor(private ctx: Context, maxIterations = 25) {
    this.def.maxIterations = maxIterations;
  }

  addNode(name: string, handler: NodeHandler<TState>): this {
    if (this.def.nodes.has(name)) {
      throw new Error(`Node "${name}" already registered.`);
    }
    this.def.nodes.set(name, handler);
    return this;
  }

  setEntryPoint(nodeName: string): this {
    this.def.entryPoint = nodeName;
    return this;
  }

  addEdge(from: string, to: string): this {
    this.def.edges.set(from, to);
    return this;
  }

  addConditionalEdge(from: string, condition: ConditionHandler<TState>): this {
    this.def.conditionalEdges.set(from, condition);
    return this;
  }

  async run(initialState: TState): Promise<GraphExecutionResult<TState>> {
    if (!this.def.entryPoint || !this.def.nodes.has(this.def.entryPoint)) {
      throw new Error("Graph must specify a valid registered entryPoint.");
    }

    let currentNode: string | undefined = this.def.entryPoint;
    let state: TState = { ...initialState };
    const trajectory: string[] = [];
    let iterations = 0;

    this.ctx.emit("graph/start", { initialState, entryPoint: this.def.entryPoint });

    while (currentNode && currentNode !== END) {
      if (++iterations > this.def.maxIterations) {
        const err = new Error(
          `Max iteration limit (${this.def.maxIterations}) exceeded. Cyclic loop terminated.`,
        );
        this.ctx.emit("graph/error", { error: err, state, lastNode: currentNode });
        throw err;
      }

      trajectory.push(currentNode);
      this.ctx.emit("graph/node-start", { node: currentNode, state, iteration: iterations });

      const handler = this.def.nodes.get(currentNode);
      if (!handler) {
        throw new Error(`Handler for node "${currentNode}" is missing.`);
      }

      try {
        const patch = await handler(state, this.ctx);
        state = { ...state, ...patch };
        this.ctx.emit("graph/node-end", { node: currentNode, state });
      } catch (nodeErr) {
        this.ctx.emit("graph/node-error", { node: currentNode, error: nodeErr });
        throw nodeErr;
      }

      if (this.def.conditionalEdges.has(currentNode)) {
        const router: ConditionHandler<TState> = this.def.conditionalEdges.get(currentNode)!;
        currentNode = await router(state, this.ctx);
      } else if (this.def.edges.has(currentNode)) {
        currentNode = this.def.edges.get(currentNode);
      } else {
        currentNode = END;
      }
    }

    this.ctx.emit("graph/end", { finalState: state, trajectory, iterations });
    return { finalState: state, trajectory, iterations };
  }
}

/** 插件配置。 */
export interface Config {
  /** 默认防死循环单次执行最大迭代上限。 */
  defaultMaxIterations: number;
  /** 是否在控制台及日志总线输出路由轨迹。 */
  logTrajectory: boolean;
}

/**
 * StateGraph 编排引擎服务（ctx.graph）。作为插件默认导出：
 * 提供隔离的状态图工厂，并在 logTrajectory 开启时订阅 graph/* 事件输出轨迹日志。
 */
export default class GraphEngineService extends Service {
  static Config: z<Config> = z.object({
    defaultMaxIterations: z
      .number()
      .default(25)
      .description("默认防死循环单次执行最大迭代上限"),
    logTrajectory: z
      .boolean()
      .default(true)
      .description("是否在控制台及日志总线输出路由轨迹"),
  });

  constructor(ctx: Context, public config: Config) {
    super(ctx, "graph");

    if (config.logTrajectory) {
      ctx.on("graph/node-start", ({ node, iteration }) => {
        ctx.logger("graph").debug(`[StateGraph] [#${iteration}] Running Node: ${node}`);
      });
      ctx.on("graph/end", ({ trajectory, iterations }) => {
        ctx.logger("graph").info(
          `[StateGraph] Completed in ${iterations} steps. Route: ${trajectory.join(" -> ")}`,
        );
      });
    }
  }

  /** 创建一个隔离的 StateGraph 实例。 */
  create<TState extends Record<string, any>>(
    maxIterations = this.config.defaultMaxIterations,
  ): StateGraph<TState> {
    return new StateGraph<TState>(this.ctx, maxIterations);
  }
}
