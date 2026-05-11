import type { EntityClass, EntityData } from '@mikro-orm/core';
import {
  type EntityManager,
  type FilterQuery,
  type FindOptions,
  SqlEntityRepository,
} from '@mikro-orm/postgresql';

export abstract class BaseDao<T extends object> {
  constructor(
    protected readonly em: EntityManager,
    private readonly entityClass: EntityClass<T>,
  ) {}

  protected getRepo(em?: EntityManager): SqlEntityRepository<T> {
    return (em ?? this.em).getRepository(
      this.entityClass,
    ) as SqlEntityRepository<T>;
  }

  async getAll(
    where: FilterQuery<T>,
    options?: FindOptions<T, never, keyof T & string>,
    txEm?: EntityManager,
  ): Promise<T[]> {
    return await this.getRepo(txEm).find(where, options as FindOptions<T>);
  }

  async getOne(
    where: FilterQuery<T>,
    options?: FindOptions<T, never, keyof T & string>,
    txEm?: EntityManager,
  ): Promise<T | null> {
    return await this.getRepo(txEm).findOne(where, options as FindOptions<T>);
  }

  async getById(id: string, txEm?: EntityManager): Promise<T | null> {
    return await this.getRepo(txEm).findOne({ id } as FilterQuery<T>);
  }

  async count(where: FilterQuery<T>, txEm?: EntityManager): Promise<number> {
    return await this.getRepo(txEm).count(where);
  }

  async create(data: Partial<T>, txEm?: EntityManager): Promise<T> {
    const manager = txEm ?? this.em;
    const entity = this.getRepo(txEm).create(data as EntityData<T>, {
      partial: true,
    });
    await manager.flush();
    return entity;
  }

  async createMany(data: Partial<T>[], txEm?: EntityManager): Promise<T[]> {
    const manager = txEm ?? this.em;
    const entities = data.map((d) =>
      this.getRepo(txEm).create(d as EntityData<T>, { partial: true }),
    );
    await manager.flush();
    return entities;
  }

  async updateById(
    id: string,
    data: Partial<T>,
    txEm?: EntityManager,
  ): Promise<number> {
    const em = txEm ?? this.em;
    const entity = await this.getRepo(txEm).findOne({ id } as FilterQuery<T>);
    if (!entity) {
      return 0;
    }
    Object.assign(entity, data);
    await em.flush();
    return 1;
  }

  async updateAndReturn(
    id: string,
    data: Partial<T>,
    txEm?: EntityManager,
  ): Promise<T> {
    const em = txEm ?? this.em;
    const entity = await this.getRepo(txEm).findOneOrFail({
      id,
    } as FilterQuery<T>);
    Object.assign(entity, data);
    await em.flush();
    return entity;
  }

  async deleteById(id: string, txEm?: EntityManager): Promise<void> {
    const em = txEm ?? this.em;
    const entity = await this.getRepo(txEm).findOne({ id } as FilterQuery<T>);
    if (!entity) {
      return;
    }
    (entity as unknown as { deletedAt: Date | null }).deletedAt = new Date();
    await em.flush();
    this.evictFromIdentityMap(entity, em);
  }

  async delete(where: FilterQuery<T>, txEm?: EntityManager): Promise<void> {
    const em = txEm ?? this.em;
    const matches = await this.getRepo(txEm).find(where);
    if (matches.length === 0) {
      return;
    }
    const now = new Date();
    for (const entity of matches) {
      (entity as unknown as { deletedAt: Date | null }).deletedAt = now;
    }
    await em.flush();
    for (const entity of matches) {
      this.evictFromIdentityMap(entity, em);
    }
  }

  async hardDeleteById(id: string, txEm?: EntityManager): Promise<void> {
    const em = txEm ?? this.em;
    const ref = em.getReference(this.entityClass, id as never);
    em.remove(ref);
    await em.flush();
  }

  async hardDelete(where: FilterQuery<T>, txEm?: EntityManager): Promise<void> {
    const em = txEm ?? this.em;
    const matches = await this.getRepo(txEm).find(where);
    if (matches.length === 0) {
      return;
    }
    for (const entity of matches) {
      em.remove(entity);
    }
    await em.flush();
  }

  /**
   * Soft-deleted entities stay in the identity map after flush, so subsequent
   * `findOne({ id })` calls hand back the cached entity and bypass the
   * `softDelete` filter — making the row look alive. Evict the cached entry
   * (without flipping `__managed = false`) so the next read goes to the DB
   * and the filter takes effect. Pre-existing JS references stay coherent.
   */
  private evictFromIdentityMap(entity: T, em: EntityManager): void {
    const uow = em.getUnitOfWork();
    uow.getIdentityMap().delete(entity);
  }
}
