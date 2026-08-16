import { Context, Service } from "@deepseek-ai/cordis";
import { randomBytes } from "node:crypto";
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

/** 图执行完成后的最终产物及全量跳转轨迹。graphId 标识实例，区分并发图的同名节点。 */
export interface GraphExecutionResult<TState = any> {
  graphId: string;
  finalState: TState;
  trajectory: string[];
  iterations: number;
}

// ---- dsh 追加式 Trajectory 事件总线（graph/* 事件载荷） ----

export interface GraphStartEvent<TState = any> {
  graphId: string;
  initialState: TState;
  entryPoint: string;
}

export interface GraphNodeStartEvent<TState = any> {
  graphId: string;
  node: string;
  state: TState;
  iteration: number;
}

export interface GraphNodeEndEvent<TState = any> {
  graphId: string;
  node: string;
  state: TState;
}

export interface GraphNodeErrorEvent {
  graphId: string;
  node: string;
  error: unknown;
}

export interface GraphErrorEvent<TState = any> {
  graphId: string;
  error: Error;
  state: TState;
  lastNode: string;
}

export interface GraphEndEvent<TState = any> {
  graphId: string;
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
  /** 本实例的唯一执行标识：注入 graph/* 事件载荷，区分并发图的同名节点轨迹。 */
  readonly id: string;

  private def: GraphDefinition<TState> = {
    nodes: new Map(),
    edges: new Map(),
    conditionalEdges: new Map(),
    maxIterations: 25,
  };

  constructor(private ctx: Context, maxIterations = 25) {
    this.id = `graph-${randomBytes(8).toString("hex")}`;
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

    this.ctx.emit("graph/start", {
      graphId: this.id,
      initialState,
      entryPoint: this.def.entryPoint,
    });

    while (currentNode && currentNode !== END) {
      // 熔断边界语义：maxIterations 指"最多执行的迭代次数"；第 maxIterations+1 次
      // 进入此处时检查并抛错终止（第 N 次仍会执行完），超限发 graph/error。
      if (++iterations > this.def.maxIterations) {
        const err = new Error(
          `Max iteration limit (${this.def.maxIterations}) exceeded. Cyclic loop terminated.`,
        );
        this.ctx.emit("graph/error", {
          graphId: this.id,
          error: err,
          state,
          lastNode: currentNode,
        });
        throw err;
      }

      trajectory.push(currentNode);
      this.ctx.emit("graph/node-start", {
        graphId: this.id,
        node: currentNode,
        state,
        iteration: iterations,
      });

      const handler = this.def.nodes.get(currentNode);
      if (!handler) {
        // 目标节点缺失（条件路由返回未注册名 / 静态边悬空）：补发 graph/error 后上抛，
        // 让轨迹观察者收到失败终结，而非静默无终态。
        const err = new Error(`Handler for node "${currentNode}" is missing.`);
        this.ctx.emit("graph/error", {
          graphId: this.id,
          error: err,
          state,
          lastNode: currentNode,
        });
        throw err;
      }

      try {
        const patch = await handler(state, this.ctx);
        state = { ...state, ...patch };
        this.ctx.emit("graph/node-end", {
          graphId: this.id,
          node: currentNode,
          state,
        });
      } catch (nodeErr) {
        this.ctx.emit("graph/node-error", {
          graphId: this.id,
          node: currentNode,
          error: nodeErr,
        });
        throw nodeErr;
      }

      try {
        if (this.def.conditionalEdges.has(currentNode)) {
          const router: ConditionHandler<TState> = this.def.conditionalEdges.get(currentNode)!;
          const next = await router(state, this.ctx);
          // 路由返回值必须是已注册节点名或 END 哨兵：undefined（忘写 return）、
          // 非字符串、未注册名一律视为路由错误，与"未注册节点名抛错"同一语义，
          // 不能静默当作正常终止（否则路由 bug 会被洗成 graph/end"成功"）。
          if (typeof next !== "string" || (next !== END && !this.def.nodes.has(next))) {
            // 只抛错不 emit：错误会被下方 catch 捕获，由它统一补发一次
            // graph/error——否则非法目标会 double-emit。
            throw new Error(
              `条件路由返回了非法目标：${JSON.stringify(next) ?? String(next)}（必须是已注册节点名或 "__END__"）。`,
            );
          }
          currentNode = next;
        } else if (this.def.edges.has(currentNode)) {
          currentNode = this.def.edges.get(currentNode);
        } else {
          currentNode = END;
        }
      } catch (routeErr) {
        // 路由函数抛错（或上方校验抛错）：补发 graph/error（此前无任何终态事件）后再上抛。
        const err =
          routeErr instanceof Error ? routeErr : new Error(String(routeErr));
        this.ctx.emit("graph/error", {
          graphId: this.id,
          error: err,
          state,
          // 循环不变量保证 currentNode 为已注册节点名（while 条件已收窄）；catch 内
          // TS 丢失该收窄，此处断言。
          lastNode: currentNode as string,
        });
        throw err;
      }
    }

    // graph/end 仅在正常终止（END 或无出边）时发出；异常终止一律走 graph/error。
    this.ctx.emit("graph/end", {
      graphId: this.id,
      finalState: state,
      trajectory,
      iterations,
    });
    return { graphId: this.id, finalState: state, trajectory, iterations };
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
