/**
 * The 10-option add inventory (T-7.6 / IT-7 — R-itin-18: 8 booking
 * categories + place visit + custom), shared by the FAB's add Sheet and the
 * form modal's in-form category step (same §2.9 ids either way:
 * `itinerary-add-option-{slug}` — the two surfaces never mount together).
 */
import { View } from "react-native";

import { Icon, ListItem } from "@/components";

import { CATEGORY_ICONS } from "../model";
import {
  ADD_OPTION_LABELS,
  ADD_OPTION_ORDER,
  addOptionSlug,
  type AddOptionId,
} from "./form-model";

export interface AddOptionListProps {
  onSelect(option: AddOptionId): void;
}

const OPTION_ICONS = {
  ...CATEGORY_ICONS,
  place_visit: "location-outline",
  custom: "create-outline",
} as const;

export function AddOptionList({ onSelect }: AddOptionListProps) {
  return (
    <View>
      {ADD_OPTION_ORDER.map((option) => (
        <ListItem
          key={option}
          title={ADD_OPTION_LABELS[option]}
          leading={<Icon name={OPTION_ICONS[option]} />}
          onPress={() => onSelect(option)}
          testID={`itinerary-add-option-${addOptionSlug(option)}`}
        />
      ))}
    </View>
  );
}
