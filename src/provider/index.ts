import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import DhlProvider from "./service"
export { default as DhlProvider } from "./service"
export type { DhlProviderOptions } from "./service"
export * from "./operation-store"
export default ModuleProvider(Modules.FULFILLMENT, { services: [DhlProvider] })
