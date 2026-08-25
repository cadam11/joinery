/**
 * Singleton base class.
 * Provides a thread-safe singleton pattern using a global object store
 */

const _globalObjectStore: Map<string, unknown> = new Map();

// Type for a class constructor that may have a protected constructor
type SingletonClass<T> = (abstract new (...args: never[]) => T) & { name: string };

export abstract class BaseSingleton {
  // Public but the class is abstract, so direct instantiation is still prevented. Declared rather
  // than omitted because subclasses call `super()`, and an implicit constructor would make the
  // chain invisible at the call site.
  constructor() {
    // Nothing to initialise: the instance lives in `_globalObjectStore`, not in this base.
  }

  /**
   * Gets the singleton instance of the class
   */
  static getInstance<T extends BaseSingleton>(this: SingletonClass<T>): T {
    const className = this.name;

    if (!_globalObjectStore.has(className)) {
      // Use type assertion for the constructor call
      const Ctor = this as unknown as new () => T;
      _globalObjectStore.set(className, new Ctor());
    }

    return _globalObjectStore.get(className) as T;
  }

  /**
   * True when the singleton has already been constructed. Lets shutdown
   * paths flush an instance without instantiating it as a side effect.
   */
  static hasInstance<T extends BaseSingleton>(this: SingletonClass<T>): boolean {
    return _globalObjectStore.has(this.name);
  }

  /**
   * Resets the singleton instance (useful for testing)
   */
  static resetInstance<T extends BaseSingleton>(this: SingletonClass<T>): void {
    const className = this.name;
    _globalObjectStore.delete(className);
  }
}
