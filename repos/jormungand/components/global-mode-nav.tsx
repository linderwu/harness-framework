"use client"

import Image from "next/image"
import {
  Bot,
  BookOpenText,
  Bug,
  Code2,
  FlaskConical,
  GitFork,
  Network,
  Search,
  Wrench
} from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import { projectTypeOptions } from "@/lib/project-templates"
import type { ProjectType } from "@/lib/types"

const icons: Record<ProjectType, typeof Search> = {
  research: Search,
  development: Code2,
  testing: FlaskConical,
  documentation: BookOpenText,
  diagnosis: Bug,
  decision: GitFork,
  agent_task: Bot,
  hive_mission: Network,
  arceus_maintenance: Wrench
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
      <div aria-hidden="true" className="globalModeDragonHead">
        <Image alt="" height={64} priority src="/jormungand-dragon-head.svg" width={108} />
      </div>
      <div className="globalModeSegments">
        {projectTypeOptions.map((option) => {
          const Icon = icons[option.type]
          const selected = option.type === value
          return (
            <button
              aria-pressed={selected}
              aria-label={option.label}
              className={`globalModeSegment${selected ? " selected" : ""}`}
              key={option.type}
              onClick={() => onChange(option.type)}
              ref={selected ? selectedRef : undefined}
              title={option.label}
              type="button"
            >
              <Icon aria-hidden="true" size={18} />
            </button>
          )
        })}
      </div>
    </nav>
  )
}
