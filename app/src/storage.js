import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// The auth token is a credential, so it goes in the keychain on device.
// SecureStore has no web implementation; there localStorage is what exists.
const secure = Platform.OS !== 'web';

export async function getItem(key) {
  try {
    return secure ? await SecureStore.getItemAsync(key) : await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setItem(key, value) {
  try {
    if (value == null) return removeItem(key);
    return secure
      ? await SecureStore.setItemAsync(key, value)
      : await AsyncStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable in a private window; never crash the app */
  }
}

export async function removeItem(key) {
  try {
    return secure
      ? await SecureStore.deleteItemAsync(key)
      : await AsyncStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
