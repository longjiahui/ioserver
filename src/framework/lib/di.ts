import { createMemberMetaDecorator, getMembers } from './decoratorUtils'
import Emitter from './emitter'

type KeyType = string | symbol | (new (...rest: any[]) => any)
type Factory<T extends KeyType = any> = (
    dic: DIC,
    ...rest: any[]
) => Awaited<T extends new (...rest: any[]) => any ? InstanceType<T> : any>

export class DIC extends Emitter<{
    provided: (key: KeyType, factory: Factory) => any
    disprovided: (key: KeyType, factory: Factory) => any
}> {
    private provides: Map<KeyType, Factory> = new Map()
    private providesRef: Map<KeyType, Factory>[] = []

    constructor(from?: DIC) {
        super()
        if (from) {
            // this.provides = new Map(from.provides)
            this.providesRef.push(...from.getAllProvides())
        }
    }

    connect(dic: DIC) {
        this.providesRef.push(...dic.getAllProvides())
    }

    getAllProvides() {
        return [this.provides, ...this.providesRef]
    }

    has(key: KeyType): boolean {
        return this.getAllProvides().some((p) => p.has(key))
    }
    set<T extends KeyType>(key: T, factory: Factory<T>) {
        if (this.has(key)) {
            console.warn(
                'providers provide conflict(key, factoryToBeSet, presentFactory): ',
                key,
                [factory],
                [this.make(key)],
            )
        }
        this.provides.set(key, factory)
        return this.emit('provided', key, factory)
    }

    get(key: KeyType) {
        return this.getAllProvides()
            .find((p) => p.get(key))
            ?.get(key)
    }

    async make<T extends KeyType>(key: T | KeyType, ...rest: any[]) {
        return this.makeWithTimeout<T>(key, 0, ...rest)
    }

    async makeWithTimeout<T extends KeyType>(
        key: T | KeyType,
        timeout: number,
        ...rest: any[]
    ): Promise<
        T extends new (...rest: any[]) => any
            ? InstanceType<T> | undefined
            : any
    > {
        let factory = this.get(key)
        if (null == factory) {
            if (timeout < 0) {
                factory = undefined
            } else {
                const providedPromise = new Promise<Factory>((r) => {
                    this.on('provided', (k, factory) => {
                        if (key === k) {
                            r(factory)
                        }
                    })
                })
                if (timeout > 0) {
                    factory = await Promise.race<Factory | undefined>([
                        // new Promise((_, reject) =>
                        new Promise((r, _) =>
                            setTimeout(() => {
                                console.warn('get timeout: ', key)
                                r(undefined)
                            }, timeout),
                        ),
                        providedPromise,
                    ])
                } else {
                    factory = await providedPromise
                }
            }
        }
        return factory?.(this, ...rest)
    }

    setWithInjectInfo<
        ProviderType extends new (...rest: any[]) => InstanceType<ProviderType>,
    >(Provider: ProviderType, customFactory?: Factory<ProviderType>) {
        this.set(Provider, async (dic, ...rest: any[]) => {
            let ret: InstanceType<ProviderType>
            if (!customFactory) {
                ret = new Provider(...rest)
            } else {
                ret = customFactory(dic, ...rest)
            }
            const members = getInjectMembers(Provider)
            if (members.length > 0) {
                await Promise.all(
                    members.map(async (m) => {
                        if (ret[m] instanceof Function) {
                            // function
                            const injectDescriptors = getInjectList(ret, m)
                            const injectParams = {}
                            for (const k of Object.keys(injectDescriptors)) {
                                const descriptor = injectDescriptors[k]
                                if (descriptor) {
                                    injectParams[k] = await descriptor.factory(
                                        dic,
                                    )
                                }
                            }
                            const originM = ret[m].bind(ret)
                            Object.defineProperty(ret, m, {
                                value: (...rest) => {
                                    Object.keys(injectParams).forEach((i) => {
                                        rest[i] = injectParams[i]
                                    })
                                    return originM(...rest)
                                },
                            })
                        } else {
                            // properties
                            Object.defineProperty(ret, m, {
                                value: await getInject(ret, m)?.(dic),
                            })
                        }
                    }),
                )
            }
            return ret
        })
    }
}
// 扩展DI Provide
type ProvideDescriptor<T extends KeyType> = {
    key?: T
    factory: Factory<T>
}

function isFactory<T extends KeyType>(
    val: Factory<T> | ProvideDescriptor<T>,
): val is Factory<T> {
    return val instanceof Function
}

export function createDIC(from?: DIC) {
    const dic = new DIC(from)
    function Provide<T extends KeyType>(
        descriptors: ProvideDescriptor<T>[] | ProvideDescriptor<T> | Factory<T>,
    ) {
        return (target: new (...rest: any[]) => any) => {
            if (!(descriptors instanceof Array)) {
                if (isFactory(descriptors)) {
                    descriptors = {
                        // warning
                        key: target as any,
                        factory: descriptors,
                    }
                }
                descriptors = [descriptors]
            }
            descriptors.forEach((d) => {
                if (d.factory) {
                    dic.set(
                        d.key || target,
                        async (dic: DIC, ...rest: any[]) => {
                            const ret = await d.factory(dic, ...rest)
                            const members = getInjectMembers(target)
                            if (members.length > 0) {
                                await Promise.all(
                                    members.map(async (m) => {
                                        if (ret[m] instanceof Function) {
                                            // function
                                            const injectDescriptors =
                                                getInjectList(ret, m)
                                            const injectParams = {}
                                            for (const k of Object.keys(
                                                injectDescriptors,
                                            )) {
                                                const descriptor =
                                                    injectDescriptors[k]
                                                if (descriptor) {
                                                    injectParams[k] =
                                                        await descriptor.factory(
                                                            dic,
                                                        )
                                                }
                                            }
                                            const originM = ret[m].bind(ret)
                                            Object.defineProperty(ret, m, {
                                                value: (...rest) => {
                                                    Object.keys(
                                                        injectParams,
                                                    ).forEach((i) => {
                                                        rest[i] =
                                                            injectParams[i]
                                                    })
                                                    return originM(...rest)
                                                },
                                            })
                                        } else {
                                            // properties
                                            Object.defineProperty(ret, m, {
                                                value: await getInject(
                                                    ret,
                                                    m,
                                                )?.(dic),
                                            })
                                        }
                                    }),
                                )
                            }
                            return ret
                        },
                    )
                }
            })
        }
    }

    return {
        dic,
        Provide,
    }
}

const injectKey = Symbol.for('inject')

const decoratorKey = Symbol.for('injectDecorator')

export function Inject<T extends KeyType>(factory: Factory<T>) {
    return createMemberMetaDecorator(
        (
            target: (new (...rest: any[]) => any) | object,
            key: string | symbol | undefined,
            index: number | undefined,
        ) => {
            if (!!key && typeof index === 'number') {
                addInject(factory, target, key, index)
            } else {
                if (key) {
                    Reflect.defineMetadata(injectKey, factory, target, key)
                } else {
                    Reflect.defineMetadata(injectKey, factory, target)
                }
            }
        },
        decoratorKey,
    )
}
export function getInjectMembers(target) {
    return getMembers(target, decoratorKey)
}
Inject.key = <T extends KeyType>(key: T, timeout = -1) => {
    return Inject((dic) => dic.makeWithTimeout(key, timeout))
}
Inject.const = (val: any) => {
    return Inject(() => val)
}

type InjectFactory = (dic: DIC) => Awaited<any>
interface InjectParamDescriptor {
    factory: InjectFactory
}

type InjectList = {
    [key: string | symbol | number]: InjectParamDescriptor | undefined
}

const injectListKey = Symbol.for('injectList')
function getInject(
    target: object,
    key: string | symbol,
): InjectFactory | undefined {
    return Reflect.getMetadata(injectKey, target, key)
}
function addInject(
    factory: Factory,
    target: object,
    key: string | symbol,
    index: number,
) {
    const injectList: InjectList =
        Reflect.getMetadata('injectListKey', target, key) || {}
    injectList[index] = {
        factory,
    }
    Reflect.defineMetadata(injectListKey, injectList, target, key)
}

function getInjectList(target: object, key: string | symbol): InjectList {
    return Reflect.getMetadata(injectListKey, target, key) || {}
}
