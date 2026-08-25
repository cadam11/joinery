/**
 * Main-process security policy (J-22): what the app window may navigate to, what code the
 * renderer may run, and what URLs may reach the OS.
 */

export {
  buildContentSecurityPolicy,
  CSP_HEADER_NAME,
  type ContentSecurityPolicyInput,
} from './content-security-policy';
export {
  assertOpenableExternalUrl,
  isOpenableExternalUrl,
  OPENABLE_SCHEMES,
  type OpenableScheme,
  UnsafeExternalUrlError,
} from './external-url';
export {
  installContentSecurityPolicy,
  installNavigationGuards,
  type NavigationGuardOptions,
  SECURITY_LOG_TAG,
} from './harden';
export {
  type AppEntry,
  decideNavigation,
  decideWindowOpen,
  type NavigationDecision,
  type WindowOpenDecision,
} from './navigation-guard';
