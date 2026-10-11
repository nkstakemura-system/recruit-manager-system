import * as SecureStore from "expo-secure-store";
import { createMobileClient } from "./mobileClient";

export const mobileClient = createMobileClient({
  getItemAsync: key => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key),
}, fetch, "https://recruit-manager-system.onrender.com");