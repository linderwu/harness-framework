"use client"

import {
  Bot,
  BookOpenText,
  Bug,
  Check,
  Code2,
  GitBranch,
  Search,
  ShieldCheck
} from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import { projectTypeOptions } from "@/lib/project-templates"
import type { ProjectType } from "@/lib/types"

const icons: Record<ProjectType, typeof Search> = {
  research: Search,
  development: Code2,
  testing: Check,
  documentation: BookOpenText,
  diagnosis: Bug,
  decision: GitBranch,
  agent_task: Bot,
  hive_mission: Bot,
  arceus_maintenance: ShieldCheck
}

export function GlobalModeNav({
  value,
  onChange
}: {
  value: ProjectType
  onChange: (type: ProjectType) => void
}) {
  const selectedRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest"
    })
  }, [value])

  return (
    <nav aria-label="Global mode" className="globalModeNav">
      {projectTypeOptions.map((option) => {
        const Icon = icons[option.type]
        const selected = option.type === value
        return (
          <button
            aria-current={selected ? "page" : undefined}
            aria-label={option.label}
            className={selected ? "selected" : undefined}
            key={option.type}
            onClick={() => onChange(option.type)}
            ref={selected ? selectedRef : undefined}
            type="button"
          >
            <Icon size={16} />
            <span>{option.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
