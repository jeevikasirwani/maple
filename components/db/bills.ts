import {
  collection,
  getDocs,
  limit,
  orderBy,
  startAfter,
  Timestamp,
  where
} from "firebase/firestore"
import { nth } from "lodash"
import { useMemo, useReducer } from "react"
import { useAsync } from "react-async-hook"
import type {
  BillHistory,
  CurrentCommittee
} from "../../functions/src/bills/types"
import { firestore } from "../firebase"
import { currentGeneralCourt, loadDoc, now, nullableQuery } from "./common"

export type MemberReference = {
  Id: string
  Name: string
  Type: number
}

export type BillContent = {
  Title: string
  BillNumber: string
  DocketNumber: string
  GeneralCourtNumber: number
  PrimarySponsor: MemberReference
  Cosponsors: MemberReference[]
  LegislationTypeName: string
  Pinslip: string
  DocumentText: string
}

export type Bill = {
  id: string
  content: BillContent
  cosponsorCount: number
  testimonyCount: number
  nextHearingAt?: Timestamp
  latestTestimonyAt?: Timestamp
  latestTestimonyId?: string
  fetchedAt: Timestamp
  history: BillHistory
  currentCommittee?: CurrentCommittee
  city?: string
}

type Action =
  | { type: "nextPage" }
  | { type: "previousPage" }
  | { type: "sort"; sort: SortOptions }
  | { type: "filter"; filter: FilterOptions | null }
  | { type: "onSuccess"; page: Bill[] }
  | { type: "error"; error: Error }

type State = {
  sort: SortOptions
  filter: FilterOptions | null
  pageKeys: (unknown[] | null | undefined)[]
  currentPageKey: unknown[] | null
  currentPage: number
  billsPerPage: number
  nextKey?: unknown
  previousKey?: unknown
  error: Error | null
}

const initialPage = {
  pageKeys: [null],
  currentPage: 0,
  currentPageKey: null,
  nextKey: undefined,
  previousKey: undefined
}

const initialState: State = {
  ...initialPage,
  billsPerPage: 10,
  sort: "id",
  filter: null,
  error: null
}

function adjacentKeys(keys: unknown[], currentPage: number) {
  return { nextKey: keys[currentPage + 1], previousKey: keys[currentPage - 1] }
}

function reducer(state: State, action: Action): State {
  if (action.type === "nextPage" || action.type === "previousPage") {
    const next = state.currentPage + (action.type === "nextPage" ? 1 : -1),
      nextKey = state.pageKeys[next]
    if (nextKey !== undefined) {
      return {
        ...state,
        currentPage: next,
        currentPageKey: nextKey,
        ...adjacentKeys(state.pageKeys, next)
      }
    } else {
      return state
    }
  } else if (action.type === "sort" && action.sort !== state.sort) {
    return { ...state, sort: action.sort, ...initialPage }
  } else if (action.type === "onSuccess") {
    const keys = [...state.pageKeys]
    const bill = nth(action.page, state.billsPerPage - 1)
    keys[state.currentPage + 1] =
      bill !== undefined ? getPageKey(bill, state.sort) : undefined
    return {
      ...state,
      pageKeys: keys,
      ...adjacentKeys(keys, state.currentPage)
    }
  } else if (action.type === "error") {
    console.warn("Error in useBills", action.error)
    return { ...state, error: action.error }
  } else if (action.type === "filter") {
    return { ...state, filter: action.filter, ...initialPage }
  }
  return state
}

export type UseBills = ReturnType<typeof useBills>
export function useBills() {
  const [
    {
      sort,
      filter,
      billsPerPage,
      currentPageKey,
      currentPage,
      nextKey,
      previousKey
    },
    dispatch
  ] = useReducer(reducer, initialState)

  const bills = useAsync(
    () => {
      return listBills(sort, filter, billsPerPage, currentPageKey)
    },
    [billsPerPage, currentPageKey, filter, sort],
    {
      onSuccess: page => dispatch({ type: "onSuccess", page }),
      onError: error => dispatch({ type: "error", error })
    }
  )

  return useMemo(
    () => ({
      billsPerPage,
      currentPage: currentPage + 1,
      nextPage: () => dispatch({ type: "nextPage" }),
      previousPage: () => dispatch({ type: "previousPage" }),
      hasNextPage: nextKey !== undefined,
      hasPreviousPage: previousKey !== undefined,
      setSort: (sort: SortOptions) => dispatch({ type: "sort", sort }),
      setFilter: (filter: FilterOptions | null) =>
        dispatch({ type: "filter", filter }),
      sort,
      error: bills.error,
      loading: bills.loading,
      bills: bills.result
    }),
    [
      billsPerPage,
      currentPage,
      nextKey,
      previousKey,
      sort,
      bills.error,
      bills.loading,
      bills.result
    ]
  )
}

/** Compatibility with existing bill pages.
 *
 * @deprecated Replace with useBill, which provides testimonyCount and
 * hearing/testimony dates
 */
export function useBillContent(id: string) {
  const { result, loading, error } = useAsync(getBill, [id])

  return {
    bill: result?.content,
    loading,
    error
  }
}

export function useBill(id: string) {
  return useAsync(getBill, [id])
}

type ListBillsSortOptions =
  | "id"
  | "cosponsorCount"
  | "testimonyCount"
  | "latestTestimony"
export type SortOptions = ListBillsSortOptions | "hearingDate"

function getOrderBy(sort: SortOptions): Parameters<typeof orderBy>[] {
  switch (sort) {
    case "cosponsorCount":
      return [["cosponsorCount", "desc"], ["id"]]
    case "id":
      return [["id"]]
    case "latestTestimony":
      return [["latestTestimonyAt", "desc"], ["id"]]
    case "testimonyCount":
      return [["testimonyCount", "desc"], ["id"]]
    case "hearingDate":
      return [["nextHearingAt", "desc"], ["id"]]
  }
}

function getPageKey(bill: Bill, sort: SortOptions): unknown[] {
  switch (sort) {
    case "cosponsorCount":
      return [bill.cosponsorCount, bill.id]
    case "hearingDate":
      return [bill.nextHearingAt, bill.id]
    case "id":
      return [bill.id]
    case "latestTestimony":
      return [bill.latestTestimonyAt, bill.id]
    case "testimonyCount":
      return [bill.testimonyCount, bill.id]
  }
}

export type FilterOptions =
  | { type: "bill"; id: string }
  | { type: "primarySponsor"; id: string }
  | { type: "committee"; id: string }
  | { type: "city"; name: string }

function getFilter(filter: FilterOptions): Parameters<typeof where> {
  switch (filter.type) {
    case "bill":
      return ["id", "==", filter.id]
    case "primarySponsor":
      return ["content.PrimarySponsor.Id", "==", filter.id]
    case "committee":
      return ["currentCommittee.id", "==", filter.id]
    case "city":
      return ["city", "==", filter.name]
  }
}

const billsRef = collection(
  firestore,
  `/generalCourts/${currentGeneralCourt}/bills`
)

async function listBills(
  sort: SortOptions,
  filter: FilterOptions | null,
  limitCount: number,
  startAfterKey: unknown[] | null
): Promise<Bill[]> {
  // Exclude the id orderBy clause if filtering on bill ID's
  const excludeOrderById = filter?.type === "bill"
  const orderByConstraints = getOrderBy(sort)
    .filter(o => !excludeOrderById || o[0] !== "id")
    .map(o => orderBy(...o))

  const result = await getDocs(
    nullableQuery(
      billsRef,
      filter && where(...getFilter(filter)),
      ...orderByConstraints,
      limit(limitCount),
      startAfterKey !== null && startAfter(...startAfterKey)
    )
  )
  return result.docs.map(d => d.data() as Bill)
}

export async function getBill(id: string): Promise<Bill | undefined> {
  const bill = await loadDoc(
    `/generalCourts/${currentGeneralCourt}/bills/${id}`
  )
  return bill as any
}

export async function listBillsByHearingDate(
  limitCount: number
): Promise<Bill[]> {
  const result = await getDocs(
    nullableQuery(
      billsRef,
      where("nextHearingAt", ">=", midnight()),
      orderBy("nextHearingAt", "asc"),
      limit(limitCount)
    )
  )
  return result.docs.map(d => d.data() as Bill)
}

export function midnight() {
  return now().set({ hour: 0, minute: 0, second: 0, millisecond: 0 }).toJSDate()
}
