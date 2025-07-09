import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react"
import clsx from "clsx"
import { Check, ChevronsUpDown } from "lucide-react"
import { useState } from "react"

export default function NameCombobox({
  name,
  setName,
  unclaimedNames,
  loading,
  setLoading,
}: {
  name: string
  setName: (v: string) => void
  unclaimedNames: string[]
  loading: boolean
  setLoading: (v: boolean) => void
}) {
  const [query, setQuery] = useState("")

  const filtered =
    query === ""
      ? unclaimedNames
      : unclaimedNames.filter((p) =>
          p.toLowerCase().includes(query.toLowerCase())
        )

  return (
    <Combobox
      value={name}
      onChange={(value: string | null) => {
        setName(value ?? "")
        setQuery(value ?? "") // never store null in state
      }}
      onClose={() => setQuery("")}
      disabled={loading}
      __demoMode
    >
      <div className="relative">
        {/* input ----------------------------------------------------------- */}
        <ComboboxInput
          className={clsx(
            "w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm text-gray-900 shadow-sm",
            "focus:outline-none focus:ring-2 focus:ring-rose-500"
          )}
          placeholder="Type or select…"
          displayValue={(v: string) => v}
          value={name || query}
          onChange={(e) => {
            setQuery(e.target.value || "")
          }}
        />

        {/* disclosure button ---------------------------------------------- */}
        <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-2">
          <ChevronsUpDown className="h-4 w-4 text-gray-400" />
        </ComboboxButton>
      </div>

      {/* options list ----------------------------------------------------- */}
      <ComboboxOptions
        anchor="bottom"
        transition
        className={clsx(
          "w-(--input-width) max-h-60 overflow-auto rounded-md border border-rose-200 bg-white py-1 shadow-lg",
          "empty:invisible transition duration-100 ease-in data-leave:data-closed:opacity-0"
        )}
      >
        {filtered.map((person) => (
          <ComboboxOption
            key={person}
            value={person}
            className={clsx(
              "group flex cursor-default select-none items-center gap-2 rounded-md px-3 py-1.5",
              "data-[headlessui-state=active]:bg-rose-50 data-[headlessui-state=active]:text-rose-700"
            )}
          >
            <Check className="invisible h-4 w-4 text-rose-600 group-data-selected:visible" />
            <span className="text-sm text-gray-900">{person}</span>
          </ComboboxOption>
        ))}
      </ComboboxOptions>
    </Combobox>
  )
}
