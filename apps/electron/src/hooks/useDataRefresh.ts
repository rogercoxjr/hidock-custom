/**
 * useDataRefresh — subscribe a view's loader to a data-freshness topic.
 *
 * When a coalesced pulse arrives for `topic` (see lib/dataFreshness), `reload` runs.
 * Pass a stable `reload` (e.g. a useCallback'd loader) so the subscription isn't torn
 * down and rebuilt every render.
 */

import { useEffect } from 'react'
import { subscribeFreshness, type FreshnessTopic } from '@/lib/dataFreshness'

export function useDataRefresh(topic: FreshnessTopic, reload: () => void): void {
  useEffect(() => {
    return subscribeFreshness(topic, reload)
  }, [topic, reload])
}
