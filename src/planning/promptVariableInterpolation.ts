export function interpolate(template: string, inputs: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in inputs === false) {
      throw new Error(`Missing interpolation key: ${key}`)
    }
    return inputs[key]
  })
}
