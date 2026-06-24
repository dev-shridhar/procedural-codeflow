export type CfgNodeKind =
  | 'entry' | 'exit'
  | 'statement'
  | 'branch'
  | 'loop'
  | 'merge'
  | 'return' | 'raise'
  | 'call'
  | 'entity';

export interface SrcRange {
  uri?: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface CfgNode {
  id: string;
  kind: CfgNodeKind;
  label: string;
  range?: SrcRange;
  regionId?: string;
  drillable?: boolean;
}

export type EdgeKind = 'normal' | 'true' | 'false' | 'loop-back' | 'exception' | 'case';

export interface CfgEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface CfgRegion {
  id: string;
  kind: 'if' | 'for' | 'while' | 'try' | 'with' | 'match';
  headerId: string;
  memberIds: string[];
  exitIds: string[];
}

export interface Cfg {
  nodes: CfgNode[];
  edges: CfgEdge[];
  regions: CfgRegion[];
  entryId: string;
  exitId: string;
}
