import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { ManagedFoodDatabase } from '../../db/managed-food-store.ts';
import type { ManagedFoodDefinition } from '../../lib/managed-food-catalog.ts';

export const managedDefinition: ManagedFoodDefinition = {
  name:'测试咖啡', aliases:['测试拿铁'],brandId:'luckin-cn',brandName:'瑞幸',category:'拿铁类',description:'仅适用于此来源明确的参考规格。',
  sourceName:'测试官方标签',sourceUrl:'https://source.example/products/coffee',portionLabel:'大杯/冰/不另外加糖',
  calories:'179.0',carbs:null,protein:'0.0',fat:null,imageUrl:'/food-images/luckin-cn/1.png',
};
export function managedFoodFixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec("CREATE TABLE app_owner_identity(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,email TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO app_owner_identity VALUES ('owner','admin','admin@example.test','2026-11-14T00:00:00Z')");
  sqlite.exec(readFileSync(new URL('../../drizzle/0021_managed_foods.sql',import.meta.url),'utf8'));
  let hook: (()=>void) | null = null;
  type Statement = { bind(...parameters: unknown[]): Statement; first<T>(): Promise<T | null>; all<T>(): Promise<{results:T[]}>; run(): Promise<unknown>; execute(): {results:unknown[];meta:{changes:number}} };
  const db = {
    prepare(sql: string) { const statement=sqlite.prepare(sql); let values: SQLInputValue[]=[];
      const bound: Statement={ bind(...parameters){values=parameters as SQLInputValue[];return bound;},
        async first<T>(){return (bound.execute().results[0] as T|undefined)??null;},
        async all<T>(){return {results:bound.execute().results as T[]};},async run(){return bound.execute();},
        execute(){const before=Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n);const results=statement.columns().length?statement.all(...values):(statement.run(...values),[]);return {results,meta:{changes:Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n)-before}};},
      };return bound;
    },
    async batch(statements: Statement[]) {const before=hook;hook=null;before?.();sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},
  } as unknown as ManagedFoodDatabase;
  return { db,sqlite,beforeBatch(callback:()=>void){hook=callback;},close(){sqlite.close();} };
}
