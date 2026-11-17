import { forwardRef } from "react";
import { TextInput as NativeTextInput, type TextInputProps } from "react-native";
import { useOnayLanguage } from "../lib/onay-language-context";
/** Localize field hints without changing editable values or native keyboard/ref behavior. */
const OnayTextInput = forwardRef<NativeTextInput, TextInputProps>(function OnayTextInput({ placeholder, accessibilityLabel, ...props }, ref) {
 const { t } = useOnayLanguage();
 return <NativeTextInput {...props} ref={ref} placeholder={placeholder ? t(placeholder) : undefined} accessibilityLabel={accessibilityLabel ? t(accessibilityLabel) : undefined}/>;
});
export default OnayTextInput;
