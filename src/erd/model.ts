export interface ErdEntity {
  name: string;
  fields: string[];
  range?: SrcRange;
}

export interface ErdRelation {
  from: string;
  to: string;
  kind: 'ref' | 'extends';
  fromField?: string;
  label?: string;
}

export interface Erd {
  entities: ErdEntity[];
  relations: ErdRelation[];
}

export interface SrcRange {
  uri?: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}
