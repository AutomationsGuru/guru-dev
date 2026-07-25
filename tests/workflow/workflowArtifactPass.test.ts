import { get, put } from '../../src/workflow/workflowArtifactPass.js';

describe('workflowArtifactPass', () => {
  it('should store and retrieve a string artifact', () => {
    put('myString', 'hello world');
    const result = get<string>('myString');
    expect(result).toBe('hello world');
  });

  it('should store and retrieve a number artifact', () => {
    put('myNumber', 123);
    const result = get<number>('myNumber');
    expect(result).toBe(123);
  });

  it('should store and retrieve an object artifact', () => {
    const myObj = { a: 1, b: 'test' };
    put('myObject', myObj);
    const result = get<{ a: number; b: string }>('myObject');
    expect(result).toEqual(myObj);
  });

  it('should return undefined for a non-existent artifact', () => {
    const result = get<string>('nonExistent');
    expect(result).toBeUndefined();
  });

  it('should handle type assertion correctly', () => {
    put('myAny', 'a string');
    const result = get<string>('myAny');
    expect(typeof result).toBe('string');
  });

  it('should fail when retrieving with an incorrect type and using it', () => {
    put('incorrectType', { foo: 'bar' });
    const result = get<{ baz: string }>('incorrectType');
    // This will cause a runtime error because baz does not exist on the object.
    // The test framework should catch this.
    expect(() => (result as any).baz.toString()).toThrow();
  });
});
